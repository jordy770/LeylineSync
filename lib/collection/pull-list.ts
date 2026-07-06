// Pull list — the physical gathering checklist for a deck: which binder holds
// each card, grouped binder → alphabetical so one walk along the shelves
// collects everything. Cards without a free binder copy land in "missing"
// with the decks that hold them (or a buy hint).

import type { SupabaseClient } from '@supabase/supabase-js'

export interface PullListGroup {
  binder: string
  cards: { name: string; need: number; have: number }[]
}

export interface PullListMissing {
  name: string
  need: number
  /** Other decks of the user that claim this card (excluding the target deck). */
  inDecks: string[]
}

export interface PullList {
  groups: PullListGroup[]
  missing: PullListMissing[]
}

interface DeckCardRow { oracleId: string; name: string; quantity: number }
interface BinderRow { oracleId: string; binder: string; quantity: number }

export async function getPullList(
  supabase: SupabaseClient,
  userId: string,
  deckId: string,
): Promise<{ result?: PullList; error?: string }> {
  const { data: deckCards, error } = await supabase
    .from('co_deck_cards')
    .select('oracle_id, quantity')
    .eq('deck_id', deckId)
  if (error) return { error: error.message }
  if (!deckCards || deckCards.length === 0) return { error: 'Deck not found or empty.' }

  const oracleIds = deckCards.map((c) => c.oracle_id)

  const names = new Map<string, string>()
  for (let i = 0; i < oracleIds.length; i += 100) {
    const { data } = await supabase
      .from('co_card_oracle')
      .select('oracle_id, name')
      .in('oracle_id', oracleIds.slice(i, i + 100))
    for (const m of data ?? []) names.set(m.oracle_id, m.name)
  }

  const binderRows: BinderRow[] = []
  for (let i = 0; i < oracleIds.length; i += 100) {
    const { data } = await supabase
      .from('co_collection_items')
      .select('oracle_id, quantity, binder_name')
      .eq('user_id', userId)
      .eq('binder_type', 'binder')
      .in('oracle_id', oracleIds.slice(i, i + 100))
    for (const r of data ?? []) {
      binderRows.push({ oracleId: r.oracle_id, binder: r.binder_name?.trim() || 'Unnamed binder', quantity: r.quantity })
    }
  }

  // Other decks holding the cards we can't pull from a binder.
  const { data: elsewhere } = await supabase
    .from('co_deck_cards')
    .select('oracle_id, co_decks!inner(id, name, user_id)')
    .eq('co_decks.user_id', userId)
    .neq('deck_id', deckId)
    .in('oracle_id', oracleIds)
  const decksByOracle = new Map<string, string[]>()
  for (const row of elsewhere ?? []) {
    const deck = Array.isArray(row.co_decks) ? row.co_decks[0] : row.co_decks
    if (!deck) continue
    const list = decksByOracle.get(row.oracle_id) ?? []
    if (!list.includes(deck.name)) list.push(deck.name)
    decksByOracle.set(row.oracle_id, list)
  }

  const cards: DeckCardRow[] = deckCards.map((c) => ({
    oracleId: c.oracle_id,
    name: names.get(c.oracle_id) ?? c.oracle_id,
    quantity: c.quantity,
  }))
  return { result: buildPullList(cards, binderRows, decksByOracle) }
}

// Pure: assign each deck card to binders greedily (fullest binder first) so the
// walk hits as few binders as possible; whatever can't be covered is "missing".
export function buildPullList(
  deckCards: DeckCardRow[],
  binderRows: BinderRow[],
  decksByOracle: Map<string, string[]> = new Map(),
): PullList {
  const stockByOracle = new Map<string, { binder: string; left: number }[]>()
  for (const row of binderRows) {
    const list = stockByOracle.get(row.oracleId) ?? []
    list.push({ binder: row.binder, left: row.quantity })
    stockByOracle.set(row.oracleId, list)
  }
  for (const list of stockByOracle.values()) list.sort((a, b) => b.left - a.left)

  const groups = new Map<string, PullListGroup['cards']>()
  const missing: PullListMissing[] = []

  for (const card of [...deckCards].sort((a, b) => a.name.localeCompare(b.name))) {
    let need = card.quantity
    for (const stock of stockByOracle.get(card.oracleId) ?? []) {
      if (need === 0) break
      const take = Math.min(need, stock.left)
      if (take === 0) continue
      stock.left -= take
      need -= take
      const cards = groups.get(stock.binder) ?? []
      cards.push({ name: card.name, need: take, have: take })
      groups.set(stock.binder, cards)
    }
    if (need > 0) {
      missing.push({ name: card.name, need, inDecks: decksByOracle.get(card.oracleId) ?? [] })
    }
  }

  return {
    groups: [...groups.entries()]
      .map(([binder, cards]) => ({ binder, cards }))
      .sort((a, b) => a.binder.localeCompare(b.binder)),
    missing,
  }
}
