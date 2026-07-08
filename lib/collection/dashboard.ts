// Dashboard data — a single read that powers the collection landing: headline
// stats, an estimated collection value, the strongest unused binder cards
// ("free staples"), the deck list with health scores, and import history.
// Pure ranking is split out + tested; the rest is straightforward aggregation.

import type { SupabaseClient } from '@supabase/supabase-js'

import { loadBinderNames, loadOracleMeta, loadTags } from './deck-loader'
import type { CardTag } from './synergy/tagger'

export interface StapleCard {
  oracleId: string
  name: string
  tag: string
  weight: number
  priceEur: number | null
  binderNames?: string[]
}

export interface DeckSummary {
  id: string
  name: string
  colorIdentity: string[]
  power: number | null
  /** Cached scan counts (mig 380) — null when the deck was never scanned (or the cache was invalidated by a re-import). */
  freeUpgrades: number | null
  occupiedUpgrades: number | null
}

export interface ImportRecord {
  id: string
  kind: string
  source: string
  filename: string | null
  rowsMatched: number | null
  rowsUnmatched: number | null
  createdAt: string
}

export interface ValuePoint {
  date: string
  valueEur: number
}

export interface DashboardData {
  totalCards: number
  uniqueCards: number
  freeCopies: number
  collectionValueEur: number
  deckCount: number
  avgPower: number | null
  freeStaples: StapleCard[]
  decks: DeckSummary[]
  imports: ImportRecord[]
  /** Snapshot value per collection import (mig 381), oldest first, plus a live "now" point. */
  valueHistory: ValuePoint[]
}

interface RankInput {
  oracleId: string
  name: string
  typeLine: string
  priceEur: number | null
  tags: CardTag[]
}

/** Pure: the strongest unused binder cards — high-synergy cards sitting idle. */
export function rankStaples(cards: RankInput[], limit = 12): StapleCard[] {
  const staples: StapleCard[] = []
  for (const c of cards) {
    if (/basic land/i.test(c.typeLine)) continue
    const best = c.tags.reduce<CardTag | null>((a, b) => (b.weight > (a?.weight ?? 0) ? b : a), null)
    if (!best || best.weight < 3) continue // only genuine staples
    staples.push({ oracleId: c.oracleId, name: c.name, tag: best.tag, weight: best.weight, priceEur: c.priceEur })
  }
  return staples
    .sort((a, b) => b.weight - a.weight || (b.priceEur ?? 0) - (a.priceEur ?? 0))
    .slice(0, limit)
}

export async function getDashboard(supabase: SupabaseClient, userId: string): Promise<DashboardData> {
  const [availRes, decksRes, importsRes, analysesRes, historyRes] = await Promise.all([
    supabase.from('co_card_availability').select('oracle_id, owned_qty, free_qty').eq('user_id', userId),
    supabase
      .from('co_decks')
      .select('id, name, color_identity, power_score')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false }),
    supabase
      .from('co_imports')
      .select('id, kind, source, filename, rows_matched, rows_unmatched, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(10),
    // RLS scopes analysis rows to the caller's decks, so no explicit filter needed.
    supabase.from('co_deck_analyses').select('deck_id, free_upgrades, occupied_upgrades'),
    supabase
      .from('co_imports')
      .select('created_at, snapshot_value_eur')
      .eq('user_id', userId)
      .eq('kind', 'collection')
      .not('snapshot_value_eur', 'is', null)
      .order('created_at', { ascending: true })
      .limit(100),
  ])

  const rows = availRes.data ?? []
  const ownedIds = rows.map((r) => r.oracle_id as string)
  const meta = await loadOracleMeta(supabase, ownedIds)

  let totalCards = 0
  let freeCopies = 0
  let collectionValueEur = 0
  for (const r of rows) {
    const owned = Number(r.owned_qty ?? 0)
    totalCards += owned
    freeCopies += Number(r.free_qty ?? 0)
    const price = meta.get(r.oracle_id as string)?.priceEur
    if (price) collectionValueEur += owned * price
  }

  const freeRows = rows.filter((r) => Number(r.free_qty ?? 0) > 0)
  const freeIds = freeRows.map((r) => r.oracle_id as string)
  const [freeTags, binderNames] = await Promise.all([loadTags(supabase, freeIds), loadBinderNames(supabase, userId, freeIds)])
  const freeStaples = rankStaples(
    freeRows.map((r) => {
      const m = meta.get(r.oracle_id as string)
      return {
        oracleId: r.oracle_id as string,
        name: m?.name ?? (r.oracle_id as string),
        typeLine: m?.typeLine ?? '',
        priceEur: m?.priceEur ?? null,
        tags: freeTags.get(r.oracle_id as string) ?? [],
      }
    }),
  ).map((s) => ({ ...s, binderNames: binderNames.get(s.oracleId) ?? [] }))

  const scanByDeck = new Map<string, { free: number | null; occupied: number | null }>()
  for (const a of analysesRes.data ?? []) {
    scanByDeck.set(a.deck_id as string, {
      free: a.free_upgrades == null ? null : Number(a.free_upgrades),
      occupied: a.occupied_upgrades == null ? null : Number(a.occupied_upgrades),
    })
  }

  const decks: DeckSummary[] = (decksRes.data ?? []).map((d) => ({
    id: d.id as string,
    name: d.name as string,
    colorIdentity: (d.color_identity as string[]) ?? [],
    power: d.power_score == null ? null : Number(d.power_score),
    freeUpgrades: scanByDeck.get(d.id as string)?.free ?? null,
    occupiedUpgrades: scanByDeck.get(d.id as string)?.occupied ?? null,
  }))
  const scored = decks.filter((d) => d.power != null)
  const avgPower = scored.length ? Math.round((scored.reduce((s, d) => s + (d.power as number), 0) / scored.length) * 10) / 10 : null

  const imports: ImportRecord[] = (importsRes.data ?? []).map((i) => ({
    id: i.id as string,
    kind: i.kind as string,
    source: i.source as string,
    filename: (i.filename as string) ?? null,
    rowsMatched: i.rows_matched == null ? null : Number(i.rows_matched),
    rowsUnmatched: i.rows_unmatched == null ? null : Number(i.rows_unmatched),
    createdAt: i.created_at as string,
  }))

  // Value over time: one point per import snapshot, closed with a live "now"
  // point at today's prices (so the chart always ends at the headline value).
  const roundedValue = Math.round(collectionValueEur * 100) / 100
  const valueHistory: ValuePoint[] = (historyRes.data ?? []).map((h) => ({
    date: h.created_at as string,
    valueEur: Math.round(Number(h.snapshot_value_eur) * 100) / 100,
  }))
  if (valueHistory.length > 0 && roundedValue > 0) {
    valueHistory.push({ date: new Date().toISOString(), valueEur: roundedValue })
  }

  return {
    totalCards,
    uniqueCards: rows.length,
    freeCopies,
    collectionValueEur: roundedValue,
    deckCount: decks.length,
    avgPower,
    freeStaples,
    decks,
    imports,
    valueHistory,
  }
}
