// Move a card from one deck to another (resolves an "occupied" upgrade — you own
// the card but it's locked in another deck). Reassigns the single physical copy;
// the availability view follows automatically.

import type { SupabaseClient } from '@supabase/supabase-js'

import { analyzeDeck } from './analyze-deck'
import { loadOracleMeta } from './deck-loader'
import { addCardToDeck, removeCardFromDeck } from './deck-mutations'

export async function moveCard(
  supabase: SupabaseClient,
  _userId: string,
  oracleId: string,
  fromDeckId: string,
  toDeckId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!oracleId || !fromDeckId || !toDeckId) return { ok: false, error: 'Missing move parameters.' }
  if (fromDeckId === toDeckId) return { ok: false, error: 'Source and destination are the same deck.' }

  // RLS returns these rows only if the caller owns both decks.
  const { data: decks } = await supabase.from('co_decks').select('id, color_identity').in('id', [fromDeckId, toDeckId])
  const from = decks?.find((d) => d.id === fromDeckId)
  const to = decks?.find((d) => d.id === toDeckId)
  if (!from || !to) return { ok: false, error: 'One of the decks was not found.' }

  const meta = (await loadOracleMeta(supabase, [oracleId])).get(oracleId)
  if (!meta) return { ok: false, error: 'Card not found.' }
  const toIdentity = (to.color_identity as string[]) ?? []
  if (!meta.colorIdentity.every((c) => toIdentity.includes(c))) {
    return { ok: false, error: `${meta.name} doesn't fit the destination deck's color identity.` }
  }

  try {
    const removed = await removeCardFromDeck(supabase, fromDeckId, oracleId)
    if (!removed) return { ok: false, error: `${meta.name} isn't in the source deck anymore.` }
    await addCardToDeck(supabase, toDeckId, oracleId)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Move failed.' }
  }

  // Both decks changed composition — refresh their cached scores (best-effort).
  await Promise.all([
    analyzeDeck(supabase, fromDeckId, { persist: true }).catch(() => {}),
    analyzeDeck(supabase, toDeckId, { persist: true }).catch(() => {}),
  ])

  return { ok: true }
}
