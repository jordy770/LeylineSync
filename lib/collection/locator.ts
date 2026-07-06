// Card locator — "where does this card live?" One name search across the
// user's physical collection (binders) and decks, with free-copy math from
// binder_type. Powers /collection/search.

import type { SupabaseClient } from '@supabase/supabase-js'

const RESULT_CAP = 30

export interface LocatedCard {
  oracleId: string
  name: string
  ownedQty: number
  /** Copies sitting in a binder (binder_type='binder') — grabbable for a deck. */
  freeQty: number
  binders: { name: string; qty: number }[]
  decks: { id: string; name: string; qty: number }[]
  colorIdentity: string[]
  typeLine: string | null
}

export interface LocatorFilters {
  freeOnly?: boolean
  /** Single-letter color (W/U/B/R/G) that must be in the card's identity. */
  color?: string | null
  /** Substring match on the type line (e.g. "creature"). */
  type?: string | null
}

export async function locateCards(
  supabase: SupabaseClient,
  userId: string,
  query: string,
  filters: LocatorFilters = {},
): Promise<LocatedCard[]> {
  const q = query.trim()
  if (q.length < 2) return []

  const { data: items } = await supabase
    .from('co_collection_items')
    .select('oracle_id, name, quantity, binder_type, binder_name')
    .eq('user_id', userId)
    .ilike('name', `%${q}%`)
    .limit(500)

  const byOracle = new Map<string, LocatedCard>()
  for (const it of items ?? []) {
    let card = byOracle.get(it.oracle_id)
    if (!card) {
      card = { oracleId: it.oracle_id, name: it.name, ownedQty: 0, freeQty: 0, binders: [], decks: [], colorIdentity: [], typeLine: null }
      byOracle.set(it.oracle_id, card)
    }
    card.ownedQty += it.quantity
    if (it.binder_type === 'binder') {
      card.freeQty += it.quantity
      const label = it.binder_name?.trim() || 'Unnamed binder'
      const binder = card.binders.find((b) => b.name === label)
      if (binder) binder.qty += it.quantity
      else card.binders.push({ name: label, qty: it.quantity })
    }
  }
  if (byOracle.size === 0) return []

  const oracleIds = [...byOracle.keys()]

  // Which of the user's decks claim these cards.
  const { data: deckRows } = await supabase
    .from('co_deck_cards')
    .select('oracle_id, quantity, co_decks!inner(id, name, user_id)')
    .eq('co_decks.user_id', userId)
    .in('oracle_id', oracleIds)
  for (const row of deckRows ?? []) {
    const deck = Array.isArray(row.co_decks) ? row.co_decks[0] : row.co_decks
    if (!deck) continue
    byOracle.get(row.oracle_id)?.decks.push({ id: deck.id, name: deck.name, qty: row.quantity })
  }

  // Identity/type metadata for the filter chips and pips.
  const { data: meta } = await supabase
    .from('co_card_oracle')
    .select('oracle_id, color_identity, type_line')
    .in('oracle_id', oracleIds)
  for (const m of meta ?? []) {
    const card = byOracle.get(m.oracle_id)
    if (!card) continue
    card.colorIdentity = m.color_identity ?? []
    card.typeLine = m.type_line ?? null
  }

  let results = [...byOracle.values()]
  if (filters.freeOnly) results = results.filter((c) => c.freeQty > 0)
  if (filters.color) {
    const want = filters.color.toUpperCase()
    results = results.filter((c) => c.colorIdentity.includes(want))
  }
  if (filters.type) {
    const want = filters.type.toLowerCase()
    results = results.filter((c) => (c.typeLine ?? '').toLowerCase().includes(want))
  }

  return results
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, RESULT_CAP)
}
