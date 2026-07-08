// Deck conflicts — cards committed to more deck slots than the player physically
// owns (the couch-play reality: the same card can't be in two decks at once). For
// each, show which decks claim it so the player can buy a copy, proxy, or pick one.

import type { SupabaseClient } from '@supabase/supabase-js'

import { loadOracleMeta, oneToOne } from './deck-loader'

export interface DeckRef {
  id: string
  name: string
}

export interface Conflict {
  oracleId: string
  name: string
  ownedQty: number
  committedQty: number
  decks: DeckRef[]
}

interface Usage {
  committed: number
  decks: DeckRef[]
}

/** Pure: an oracle is a conflict when its committed copies exceed owned copies. */
export function computeConflicts(
  usage: Map<string, Usage>,
  owned: Map<string, number>,
  names: Map<string, string>,
): Conflict[] {
  const conflicts: Conflict[] = []
  for (const [oracleId, u] of usage) {
    const ownedQty = owned.get(oracleId) ?? 0
    if (u.committed > ownedQty) {
      conflicts.push({ oracleId, name: names.get(oracleId) ?? oracleId, ownedQty, committedQty: u.committed, decks: u.decks })
    }
  }
  // Worst shortfall first, then most-contested.
  return conflicts.sort((a, b) => b.committedQty - b.ownedQty - (a.committedQty - a.ownedQty) || b.decks.length - a.decks.length)
}

export async function listConflicts(supabase: SupabaseClient, userId: string): Promise<Conflict[]> {
  // Every deck-card the user has, with its deck (RLS already scopes to own decks).
  const { data: rows, error } = await supabase
    .from('co_deck_cards')
    .select('oracle_id, quantity, co_decks!inner(id, name, user_id)')
    .limit(10000)
  if (error) throw new Error(`Conflict load failed: ${error.message}`)

  const usage = new Map<string, Usage>()
  for (const r of rows ?? []) {
    const deck = oneToOne(r.co_decks)
    if (!deck || deck.user_id !== userId) continue
    const oracleId = r.oracle_id as string
    const entry = usage.get(oracleId) ?? { committed: 0, decks: [] }
    entry.committed += (r.quantity as number) ?? 1
    entry.decks.push({ id: deck.id as string, name: deck.name as string })
    usage.set(oracleId, entry)
  }
  if (usage.size === 0) return []

  // Owned copies per oracle — paged (an un-ranged select caps at 1000 rows,
  // which undercounted big collections and invented conflicts, bug-1116).
  const owned = new Map<string, number>()
  for (let from = 0; ; from += 1000) {
    const { data: items, error: itemsError } = await supabase
      .from('co_collection_items')
      .select('oracle_id, quantity')
      .eq('user_id', userId)
      .order('id')
      .range(from, from + 999)
    if (itemsError) throw new Error(`Collection load failed: ${itemsError.message}`)
    for (const i of items ?? []) {
      owned.set(i.oracle_id as string, (owned.get(i.oracle_id as string) ?? 0) + ((i.quantity as number) ?? 0))
    }
    if (!items || items.length < 1000) break
  }

  const meta = await loadOracleMeta(supabase, [...usage.keys()])
  const names = new Map<string, string>()
  for (const [id, m] of meta) {
    // Basic lands are infinitely available — never a conflict.
    if (/basic land/i.test(m.typeLine)) usage.delete(id)
    else names.set(id, m.name)
  }

  return computeConflicts(usage, owned, names)
}
