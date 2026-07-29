import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { forEachIdChunk, IN_CHUNK, loadOracleMeta } from '@/lib/collection/deck-loader'
import { validateProposal } from '@/lib/collection/proposal-validate'
import type { CardMeta, SavePayloadBasics, SavePayloadCard } from '@/lib/collection/proposal-validate'
import { createClient } from '@/lib/supabase/server'

// POST /api/collection/commanders/save-deck  body: { oracleId, name, cards, basics } → { deckId }
// Persists a generated DeckProposal the user chose to save. The client's
// proposal is untrusted (collection may have changed since it was generated,
// payload may be hand-crafted), so this route re-derives a fresh CardMeta
// snapshot and re-runs validateProposal server-side before writing anything —
// never trusts the client's own totals/ownership/identity claims.
// Mirrors the insert/cleanup/chunking pattern of lib/collection/import-deck.ts.

const INSERT_CHUNK = 500

/** oracle_id → {colorIdentity, typeLine, ownedQty} for the submitted card ids, chunked. */
async function loadCardMeta(supabase: SupabaseClient, userId: string, oracleIds: string[]): Promise<Map<string, CardMeta>> {
  const oracleMeta = await loadOracleMeta(supabase, oracleIds)

  const ownedByOracle = new Map<string, number>()
  await forEachIdChunk(oracleIds, IN_CHUNK, async (chunk) => {
    const { data, error } = await supabase
      .from('co_card_availability')
      .select('oracle_id, owned_qty')
      .eq('user_id', userId)
      .in('oracle_id', chunk)
    if (error) throw new Error(`Availability lookup failed: ${error.message}`)
    for (const r of data ?? []) ownedByOracle.set(r.oracle_id as string, Number(r.owned_qty ?? 0))
  })

  const out = new Map<string, CardMeta>()
  for (const oracleId of oracleIds) {
    const meta = oracleMeta.get(oracleId)
    if (!meta) continue // left unresolved → validateProposal reports it as unknown
    out.set(oracleId, {
      oracleId,
      colorIdentity: meta.colorIdentity,
      typeLine: meta.typeLine,
      ownedQty: ownedByOracle.get(oracleId) ?? 0,
    })
  }
  return out
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data, error: authError } = await supabase.auth.getClaims()
  if (authError || !data?.claims?.sub) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  const userId = data.claims.sub as string

  const body = await request.json().catch(() => null)
  const oracleId = typeof body?.oracleId === 'string' ? body.oracleId.trim() : ''
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const cards: SavePayloadCard[] = Array.isArray(body?.cards) ? body.cards : []
  const basics: SavePayloadBasics = Array.isArray(body?.basics) ? body.basics : []
  if (!oracleId) {
    return NextResponse.json({ error: 'oracleId is required' }, { status: 400 })
  }
  // Reject an oversized payload before any DB lookups — otherwise a huge
  // tampered cards[]/basics[] array reaches loadCardMeta's chunked
  // co_card_oracle/co_card_availability .in() queries (up to ~500 rows'
  // worth) before validateProposal's own MAX_DECK_SIZE check ever runs.
  // Mirrors that same 100-card cap (1 commander + cards + basics).
  if (1 + cards.length + basics.length > 100) {
    return NextResponse.json({ error: 'Proposal is too large' }, { status: 400 })
  }

  const { data: commanderRow, error: commanderError } = await supabase
    .from('co_card_oracle')
    .select('color_identity')
    .eq('oracle_id', oracleId)
    .maybeSingle()
  if (commanderError) {
    return NextResponse.json({ error: `Could not look up the commander: ${commanderError.message}` }, { status: 500 })
  }
  if (!commanderRow) {
    return NextResponse.json({ error: 'Commander not found' }, { status: 404 })
  }
  // Required — the '{}' column default rejects every colored card once
  // move-card/apply-swap gate on it later (phase-1 lesson, mirrors
  // start-deck's convention).
  const colorIdentity = [...new Set((commanderRow.color_identity as string[]) ?? [])].sort()

  let metaByOracle: Map<string, CardMeta>
  try {
    metaByOracle = await loadCardMeta(supabase, userId, cards.map((c) => c.oracleId))
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Card lookup failed' }, { status: 500 })
  }

  // Basics aren't submitted with an oracleId (the client only knows the land
  // name) — resolve each to the catalog's true basic-land printing BEFORE
  // validation and before any row is written. This lets validateProposal
  // reject a cards[] oracleId that collides with a resolved basic (a
  // duplicate-card exploit that used to slip past the cards-only duplicate
  // check and reach the insert as two rows for one physical land), and keeps
  // a resolution failure a clean no-op — nothing's been created yet, so
  // there's no co_decks row to roll back on error, unlike before.
  const basicOracleIds = new Map<string, string>()
  for (const b of basics) {
    const { data: basicRow, error: basicError } = await supabase
      .from('co_card_oracle')
      .select('oracle_id')
      .ilike('type_line', 'Basic Land%')
      .eq('name', b.name)
      .maybeSingle()
    if (basicError || !basicRow) {
      return NextResponse.json({ error: `Could not resolve basic land "${b.name}"` }, { status: 500 })
    }
    basicOracleIds.set(b.name, basicRow.oracle_id as string)
  }

  const validation = validateProposal(cards, basics, colorIdentity, metaByOracle, oracleId, basicOracleIds)
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 })
  }

  const { data: deckRow, error: deckError } = await supabase
    .from('co_decks')
    .insert({ user_id: userId, name: name || 'New deck', commander_oracle_id: oracleId, color_identity: colorIdentity })
    .select('id')
    .single()
  if (deckError || !deckRow) {
    return NextResponse.json({ error: `Could not create the deck: ${deckError?.message ?? 'unknown'}` }, { status: 500 })
  }
  const deckId = deckRow.id as string

  const basicRows = basics.map((b) => ({
    deck_id: deckId,
    oracle_id: basicOracleIds.get(b.name) as string,
    quantity: b.quantity,
    is_commander: false,
  }))

  // Every row must explicitly set is_commander (not just the commander row):
  // PostgREST's bulk insert unions the key set across the whole batch, so a
  // row missing a key present on ANOTHER row in the same call gets an
  // explicit NULL, not the column default — violates co_deck_cards'
  // `is_commander boolean not null default false`. Found via real-DB e2e
  // verification (bug-2701), not caught by unit tests (route isn't unit
  // tested; validateProposal's tests use synthetic inputs, no DB round-trip).
  const rows = [
    { deck_id: deckId, oracle_id: oracleId, quantity: 1, is_commander: true },
    ...cards.map((c) => ({ deck_id: deckId, oracle_id: c.oracleId, quantity: 1, is_commander: false })),
    ...basicRows,
  ]

  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const { error: cardError } = await supabase.from('co_deck_cards').insert(rows.slice(i, i + INSERT_CHUNK))
    if (cardError) {
      await supabase.from('co_decks').delete().eq('id', deckId)
      return NextResponse.json({ error: `Could not save the deck cards: ${cardError.message}` }, { status: 500 })
    }
  }

  return NextResponse.json({ deckId })
}
