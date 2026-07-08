// Binder browsing — "what's physically in binder X?" The search page answers
// per-card questions; this answers the per-container one. Only binder_type
// 'binder' rows count (cards sleeved in decks live on the deck pages).
//
// A whole collection is at most a few thousand rows, so we load the user's
// binder rows once and aggregate in JS — that also sidesteps NULL-vs-empty
// binder_name matching in SQL (both render as "Unnamed binder").

import type { SupabaseClient } from '@supabase/supabase-js'

import { loadOracleMeta } from './deck-loader'

export const UNNAMED_BINDER = 'Unnamed binder'

export interface BinderSummary {
  name: string
  uniqueCards: number
  totalCards: number
}

export interface BinderCard {
  oracleId: string
  name: string
  qty: number
  typeLine: string | null
  colorIdentity: string[]
  priceEur: number | null
}

interface BinderRow {
  oracle_id: string
  name: string
  quantity: number
  binder_name: string | null
}

async function loadBinderRows(supabase: SupabaseClient, userId: string): Promise<BinderRow[]> {
  const rows: BinderRow[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('co_collection_items')
      .select('oracle_id, name, quantity, binder_name')
      .eq('user_id', userId)
      .eq('binder_type', 'binder')
      .range(from, from + 999)
    if (error) throw new Error(`Binder load failed: ${error.message}`)
    rows.push(...((data ?? []) as BinderRow[]))
    if (!data || data.length < 1000) break
  }
  return rows
}

function binderLabel(raw: string | null): string {
  return raw?.trim() || UNNAMED_BINDER
}

export async function listBinders(supabase: SupabaseClient, userId: string): Promise<BinderSummary[]> {
  const rows = await loadBinderRows(supabase, userId)
  const byBinder = new Map<string, { unique: Set<string>; total: number }>()
  for (const r of rows) {
    const label = binderLabel(r.binder_name)
    const entry = byBinder.get(label) ?? { unique: new Set<string>(), total: 0 }
    entry.unique.add(r.oracle_id)
    entry.total += r.quantity
    byBinder.set(label, entry)
  }
  return [...byBinder.entries()]
    .map(([name, e]) => ({ name, uniqueCards: e.unique.size, totalCards: e.total }))
    .sort((a, b) => b.totalCards - a.totalCards || a.name.localeCompare(b.name))
}

export async function getBinderContents(
  supabase: SupabaseClient,
  userId: string,
  binderName: string,
): Promise<BinderCard[]> {
  const rows = await loadBinderRows(supabase, userId)
  const inBinder = rows.filter((r) => binderLabel(r.binder_name) === binderName)

  const byOracle = new Map<string, BinderCard>()
  for (const r of inBinder) {
    const card = byOracle.get(r.oracle_id) ?? {
      oracleId: r.oracle_id,
      name: r.name,
      qty: 0,
      typeLine: null,
      colorIdentity: [],
      priceEur: null,
    }
    card.qty += r.quantity
    byOracle.set(r.oracle_id, card)
  }

  const meta = await loadOracleMeta(supabase, [...byOracle.keys()])
  for (const [oracleId, card] of byOracle) {
    const m = meta.get(oracleId)
    if (!m) continue
    card.name = m.name
    card.typeLine = m.typeLine
    card.colorIdentity = m.colorIdentity
    card.priceEur = m.priceEur
  }

  return [...byOracle.values()].sort((a, b) => a.name.localeCompare(b.name))
}
