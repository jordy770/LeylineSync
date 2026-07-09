// Shared deck loading for scoring + scanning. Both the analysis endpoint and the
// upgrade scanner need a deck's cards with oracle metadata and synergy tags; this
// is the one place that assembles them.

import type { SupabaseClient } from '@supabase/supabase-js'

import { sanitizeTargetOverrides } from './power-score'
import type { DeckCardForScore, TargetOverrides } from './power-score'

export interface CardLocks {
  /** Pet cards — never propose cutting these. */
  locked: string[]
  /** Dismissed suggestions — never propose adding these. */
  excluded: string[]
}

/** Pure: only uuid-shaped ids survive, deduped and capped. Null = no locks. */
export function sanitizeCardLocks(input: unknown): CardLocks | null {
  if (input == null || typeof input !== 'object') return null
  const take = (v: unknown): string[] =>
    Array.isArray(v)
      ? [...new Set(v.filter((x): x is string => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x)))].slice(0, 400)
      : []
  const locked = take((input as Record<string, unknown>).locked)
  const excluded = take((input as Record<string, unknown>).excluded)
  return locked.length > 0 || excluded.length > 0 ? { locked, excluded } : null
}
import type { CardTag, SynergyTag } from './synergy/tagger'
import type { InDeckCard } from './upgrade-scanner'

// supabase-js `.in()` puts every id in the GET URL; ~300 uuids overflows the gateway's
// URI limit ("URI too long"). 100 keeps each request well under it. Exported so every
// chunked `.in()` loader uses the same safe size.
export const IN_CHUNK = 100

// A 5000+-unique collection means 50+ chunks — run them CONCURRENTLY (bounded)
// instead of one round trip at a time, or the dashboard takes seconds per view
// (perf regression after the bug-1116 pagination fix surfaced the full set).
const CHUNK_CONCURRENCY = 8

/** Run `fn` over id-chunks of `size`, at most CHUNK_CONCURRENCY in flight. */
export async function forEachIdChunk(
  ids: string[],
  size: number,
  fn: (chunk: string[]) => Promise<void>,
): Promise<void> {
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size))
  for (let i = 0; i < chunks.length; i += CHUNK_CONCURRENCY) {
    await Promise.all(chunks.slice(i, i + CHUNK_CONCURRENCY).map(fn))
  }
}

export interface LoadedDeck {
  found: boolean
  deckIdentity: string[]
  deckOracleIds: Set<string>
  scoreCards: DeckCardForScore[]
  inDeck: InDeckCard[]
  /** The deck's own target tuning (mig 384) — null = classic guidelines. */
  targetOverrides: TargetOverrides | null
  /** Pet cards / dismissed suggestions (mig 385) — null = no locks. */
  cardLocks: CardLocks | null
}

export async function loadDeckForScoring(supabase: SupabaseClient, deckId: string): Promise<LoadedDeck> {
  const empty: LoadedDeck = {
    found: false,
    deckIdentity: [],
    deckOracleIds: new Set(),
    scoreCards: [],
    inDeck: [],
    targetOverrides: null,
    cardLocks: null,
  }

  const { data: deck, error: deckError } = await supabase
    .from('co_decks')
    .select('id, color_identity, target_overrides, card_locks')
    .eq('id', deckId)
    .single()
  if (deckError || !deck) return empty

  const { data: rows, error: dcError } = await supabase
    .from('co_deck_cards')
    .select('oracle_id, quantity, is_commander')
    .eq('deck_id', deckId)
  if (dcError) throw new Error(`Could not load deck cards: ${dcError.message}`)

  const deckOracleIds = new Set((rows ?? []).map((r) => r.oracle_id as string))
  // co_card_oracle is a view (no FK), so it can't be PostgREST-embedded — join by hand.
  const [tagsByOracle, metaByOracle] = await Promise.all([
    loadTags(supabase, [...deckOracleIds]),
    loadOracleMeta(supabase, [...deckOracleIds]),
  ])

  const scoreCards: DeckCardForScore[] = []
  const inDeck: InDeckCard[] = []
  for (const r of rows ?? []) {
    const oracleId = r.oracle_id as string
    const meta = metaByOracle.get(oracleId)
    const tags = tagsByOracle.get(oracleId) ?? []
    scoreCards.push({
      oracleId,
      quantity: (r.quantity as number) ?? 1,
      cmc: meta?.cmc ?? 0,
      typeLine: meta?.typeLine ?? '',
      isCommander: Boolean(r.is_commander),
      tags,
    })
    inDeck.push({ oracleId, name: meta?.name ?? oracleId, tags, priceEur: meta?.priceEur ?? null })
  }

  return {
    found: true,
    deckIdentity: (deck.color_identity as string[]) ?? [],
    deckOracleIds,
    scoreCards,
    inDeck,
    targetOverrides: sanitizeTargetOverrides(deck.target_overrides),
    cardLocks: sanitizeCardLocks(deck.card_locks),
  }
}

export interface AvailabilityRow {
  oracleId: string
  ownedQty: number
  freeQty: number
  committedQty: number
}

/** The user's ENTIRE availability view, paged — PostgREST silently caps an
 *  un-ranged select at 1000 rows, which truncated every >1000-unique
 *  collection (bug-1116). Ordered by oracle_id so the pages are stable. */
export async function loadAvailability(supabase: SupabaseClient, userId: string): Promise<AvailabilityRow[]> {
  const rows: AvailabilityRow[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('co_card_availability')
      .select('oracle_id, owned_qty, free_qty, committed_qty')
      .eq('user_id', userId)
      .order('oracle_id')
      .range(from, from + 999)
    if (error) throw new Error(`Availability load failed: ${error.message}`)
    for (const r of data ?? []) {
      rows.push({
        oracleId: r.oracle_id as string,
        ownedQty: Number(r.owned_qty ?? 0),
        freeQty: Number(r.free_qty ?? 0),
        committedQty: Number(r.committed_qty ?? 0),
      })
    }
    if (!data || data.length < 1000) break
  }
  return rows
}

export interface OracleMeta {
  name: string
  cmc: number
  typeLine: string
  colorIdentity: string[]
  priceEur: number | null
}

export async function loadOracleMeta(supabase: SupabaseClient, oracleIds: string[]): Promise<Map<string, OracleMeta>> {
  const out = new Map<string, OracleMeta>()
  await forEachIdChunk(oracleIds, IN_CHUNK, async (chunk) => {
    const { data, error } = await supabase
      .from('co_card_oracle')
      .select('oracle_id, name, cmc, type_line, color_identity, prices')
      .in('oracle_id', chunk)
    if (error) throw new Error(`Oracle meta load failed: ${error.message}`)
    for (const r of data ?? []) {
      const prices = r.prices as Record<string, string> | null
      out.set(r.oracle_id as string, {
        name: r.name as string,
        cmc: Number(r.cmc) || 0,
        typeLine: (r.type_line as string) ?? '',
        colorIdentity: (r.color_identity as string[]) ?? [],
        priceEur: prices?.eur ? Number(prices.eur) : null,
      })
    }
  })
  return out
}

/** oracle_id → distinct binder name(s) the player's FREE copies sit in (for "go find it"). */
export async function loadBinderNames(
  supabase: SupabaseClient,
  userId: string,
  oracleIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (oracleIds.length === 0) return out
  await forEachIdChunk(oracleIds, IN_CHUNK, async (chunk) => {
    const { data, error } = await supabase
      .from('co_collection_items')
      .select('oracle_id, binder_name')
      .eq('user_id', userId)
      .eq('binder_type', 'binder')
      .in('oracle_id', chunk)
    if (error) throw new Error(`Binder name load failed: ${error.message}`)
    for (const r of data ?? []) {
      const name = (r.binder_name as string | null)?.trim()
      if (!name) continue
      const list = out.get(r.oracle_id as string) ?? []
      if (!list.includes(name)) list.push(name)
      out.set(r.oracle_id as string, list)
    }
  })
  return out
}

export async function loadTags(supabase: SupabaseClient, oracleIds: string[]): Promise<Map<string, CardTag[]>> {
  const out = new Map<string, CardTag[]>()
  await forEachIdChunk(oracleIds, IN_CHUNK, async (chunk) => {
    const { data, error } = await supabase.from('co_card_tags').select('oracle_id, tag, weight').in('oracle_id', chunk)
    if (error) throw new Error(`Tag load failed: ${error.message}`)
    for (const r of data ?? []) {
      const list = out.get(r.oracle_id as string) ?? []
      list.push({ tag: r.tag as SynergyTag, weight: Number(r.weight) || 1 })
      out.set(r.oracle_id as string, list)
    }
  })
  return out
}

// Supabase types an embedded to-one relation as an array in some versions; collapse it.
export function oneToOne<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}
