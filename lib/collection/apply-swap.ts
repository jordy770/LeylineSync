// Apply a free upgrade: cut OUT (optional) and add IN to a deck. The physical card
// isn't consumed — this just reassigns deck slots; the availability view recomputes
// free/committed automatically. Validates ownership + color-identity fit so a stale
// or hand-crafted request can't put an illegal card in the deck.
//
// inOracleId may be null for a REMOVE-ONLY call — the undo of an add-only
// upgrade. At least one of in/out is required.

import type { SupabaseClient } from '@supabase/supabase-js'

import { analyzeDeck } from './analyze-deck'
import { loadOracleMeta } from './deck-loader'
import { addCardToDeck, removeCardFromDeck } from './deck-mutations'

export async function applySwap(
  supabase: SupabaseClient,
  userId: string,
  deckId: string,
  outOracleId: string | null,
  inOracleId: string | null,
): Promise<{ ok: boolean; error?: string }> {
  if (!inOracleId && !outOracleId) return { ok: false, error: 'Nothing to swap.' }

  const { data: deck } = await supabase.from('co_decks').select('id, color_identity').eq('id', deckId).maybeSingle()
  if (!deck) return { ok: false, error: 'Deck not found.' }
  const deckIdentity = (deck.color_identity as string[]) ?? []

  if (inOracleId) {
    // The incoming card must exist, fit the deck's colors, and be one the user owns.
    const meta = (await loadOracleMeta(supabase, [inOracleId])).get(inOracleId)
    if (!meta) return { ok: false, error: 'Card not found.' }
    if (!meta.colorIdentity.every((c) => deckIdentity.includes(c))) {
      return { ok: false, error: `${meta.name} doesn't fit this deck's color identity.` }
    }
    const { data: owned } = await supabase
      .from('co_collection_items')
      .select('id')
      .eq('user_id', userId)
      .eq('oracle_id', inOracleId)
      .limit(1)
    if (!owned || owned.length === 0) return { ok: false, error: `You don't own ${meta.name}.` }
  }

  try {
    if (outOracleId) {
      const removed = await removeCardFromDeck(supabase, deckId, outOracleId)
      if (!removed) return { ok: false, error: 'The card to cut is no longer in the deck.' }
    }
    if (inOracleId) await addCardToDeck(supabase, deckId, inOracleId)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Swap failed.' }
  }

  // Refresh the cached power score so list/overview views stay in sync (best-effort).
  await analyzeDeck(supabase, deckId, { persist: true }).catch(() => {})

  return { ok: true }
}
