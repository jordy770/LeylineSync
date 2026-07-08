// Shared deck loading for scoring + scanning. Both the analysis endpoint and the
// upgrade scanner need a deck's cards with oracle metadata and synergy tags; this
// is the one place that assembles them.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { DeckCardForScore } from './power-score'
import type { CardTag, SynergyTag } from './synergy/tagger'
import type { InDeckCard } from './upgrade-scanner'

// supabase-js `.in()` puts every id in the GET URL; ~300 uuids overflows the gateway's
// URI limit ("URI too long"). 100 keeps each request well under it. Exported so every
// chunked `.in()` loader uses the same safe size.
export const IN_CHUNK = 100

export interface LoadedDeck {
  found: boolean
  deckIdentity: string[]
  deckOracleIds: Set<string>
  scoreCards: DeckCardForScore[]
  inDeck: InDeckCard[]
}

export async function loadDeckForScoring(supabase: SupabaseClient, deckId: string): Promise<LoadedDeck> {
  const empty: LoadedDeck = { found: false, deckIdentity: [], deckOracleIds: new Set(), scoreCards: [], inDeck: [] }

  const { data: deck, error: deckError } = await supabase
    .from('co_decks')
    .select('id, color_identity')
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
  }
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
  for (let i = 0; i < oracleIds.length; i += IN_CHUNK) {
    const chunk = oracleIds.slice(i, i + IN_CHUNK)
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
  }
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
  for (let i = 0; i < oracleIds.length; i += IN_CHUNK) {
    const chunk = oracleIds.slice(i, i + IN_CHUNK)
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
  }
  return out
}

export async function loadTags(supabase: SupabaseClient, oracleIds: string[]): Promise<Map<string, CardTag[]>> {
  const out = new Map<string, CardTag[]>()
  for (let i = 0; i < oracleIds.length; i += IN_CHUNK) {
    const chunk = oracleIds.slice(i, i + IN_CHUNK)
    const { data, error } = await supabase.from('co_card_tags').select('oracle_id, tag, weight').in('oracle_id', chunk)
    if (error) throw new Error(`Tag load failed: ${error.message}`)
    for (const r of data ?? []) {
      const list = out.get(r.oracle_id as string) ?? []
      list.push({ tag: r.tag as SynergyTag, weight: Number(r.weight) || 1 })
      out.set(r.oracle_id as string, list)
    }
  }
  return out
}

// Supabase types an embedded to-one relation as an array in some versions; collapse it.
export function oneToOne<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}
