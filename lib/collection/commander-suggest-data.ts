// Buildable commanders (phase 1) — server-side data loader. Mapping only: turns
// the co_ views into OwnedOracleCard shapes for lib/collection/commander-suggest.ts's
// pure scoring functions. No scoring logic lives here.
// Spec: docs/superpowers/specs/2026-07-29-buildable-commanders-design.md

import type { SupabaseClient } from '@supabase/supabase-js'

import { isCommanderEligible } from './commander-suggest'
import type { OwnedOracleCard } from './commander-suggest'
import { fitsColorIdentity } from './upgrade-scanner'
import { forEachIdChunk, IN_CHUNK, loadAvailability, loadTags } from './deck-loader'
import type { ProposalBucket } from './deck-generator'

const SEARCH_LIMIT = 12

// Bounded overfetch per gap-bucket tag query, ordered by tag weight desc, before the
// TS-side owned-exclusion + color-identity filter. 50 is safe: co_card_tags rows for a
// single bucket tag are a small slice of the catalog, and taking the 50 best-weighted
// matches virtually always leaves ≥2 unowned, identity-fitting cards to shop for — this
// is a "buy suggestion" nicety, not a completeness guarantee, so a bounded miss is fine.
const GAP_BUY_OVERFETCH = 50
const GAP_BUY_TAKE = 2

/** Escape ilike wildcards (and the escape character itself) so literal %/_/\ in the query can't alter the pattern. */
const escapeIlike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

interface OracleRow {
  oracleId: string
  name: string
  typeLine: string
  oracleText: string
  colorIdentity: string[]
  keywords: string[]
  cmc: number
}

function toOracleRow(r: Record<string, unknown>): OracleRow {
  return {
    oracleId: r.oracle_id as string,
    name: r.name as string,
    typeLine: (r.type_line as string) ?? '',
    oracleText: (r.oracle_text as string) ?? '',
    colorIdentity: (r.color_identity as string[]) ?? [],
    keywords: (r.keywords as string[]) ?? [],
    cmc: (r.cmc as number) ?? 0,
  }
}

const ORACLE_COLUMNS = 'oracle_id, name, type_line, oracle_text, color_identity, keywords, cmc'

/** oracle_id → full card shape (name/type/text/identity/keywords), chunked. */
async function loadOracleRows(supabase: SupabaseClient, oracleIds: string[]): Promise<Map<string, OracleRow>> {
  const out = new Map<string, OracleRow>()
  await forEachIdChunk(oracleIds, IN_CHUNK, async (chunk) => {
    const { data, error } = await supabase.from('co_card_oracle').select(ORACLE_COLUMNS).in('oracle_id', chunk)
    if (error) throw new Error(`Oracle row load failed: ${error.message}`)
    for (const r of data ?? []) out.set(r.oracle_id as string, toOracleRow(r as Record<string, unknown>))
  })
  return out
}

/**
 * The user's whole owned collection as OwnedOracleCard shapes: availability
 * (owned/free qty) joined with oracle metadata and synergy tags. Cards with
 * no co_card_oracle match (unresolved imports) are skipped — nothing to score.
 */
export async function loadOwnedOracleCards(supabase: SupabaseClient, userId: string): Promise<OwnedOracleCard[]> {
  const availability = await loadAvailability(supabase, userId)
  if (availability.length === 0) return []

  const oracleIds = availability.map((a) => a.oracleId)
  const [oracleRows, tagsByOracle] = await Promise.all([
    loadOracleRows(supabase, oracleIds),
    loadTags(supabase, oracleIds),
  ])

  const cards: OwnedOracleCard[] = []
  for (const a of availability) {
    const meta = oracleRows.get(a.oracleId)
    if (!meta) continue
    cards.push({
      oracleId: meta.oracleId,
      name: meta.name,
      typeLine: meta.typeLine,
      oracleText: meta.oracleText,
      colorIdentity: meta.colorIdentity,
      keywords: meta.keywords,
      cmc: meta.cmc,
      ownedQty: a.ownedQty,
      freeQty: a.freeQty,
      tags: tagsByOracle.get(a.oracleId) ?? [],
    })
  }
  return cards
}

/** Name search over the full card catalog, eligible commanders only, capped and name-ordered. */
export async function searchCommanderCatalog(
  supabase: SupabaseClient,
  query: string,
): Promise<{ oracleId: string; name: string; typeLine: string; colorIdentity: string[] }[]> {
  const q = query.trim()
  if (!q) return []
  const pattern = `%${escapeIlike(q)}%`

  // Eligibility must be pushed into the SQL, not applied after `.limit()` — a name
  // query like "dragon" matches hundreds of non-eligible cards, and if they sort
  // ahead of the (fewer) eligible ones alphabetically, limit-then-filter can starve
  // out or entirely miss commanders that do exist. This mirrors isCommanderEligible
  // exactly (type_line has both "legendary" and "creature", OR oracle_text has "can
  // be your commander"); isCommanderEligible below stays the source of truth on the
  // returned rows.
  const { data, error } = await supabase
    .from('co_card_oracle')
    .select(ORACLE_COLUMNS)
    .ilike('name', pattern)
    .or('and(type_line.ilike.%legendary%,type_line.ilike.%creature%),oracle_text.ilike.%can be your commander%')
    .order('name')
    .limit(SEARCH_LIMIT)
  if (error) throw new Error(`Commander search failed: ${error.message}`)

  return (data ?? [])
    .map((r) => toOracleRow(r as Record<string, unknown>))
    .filter((r) => isCommanderEligible(r.typeLine, r.oracleText))
    .map((r) => ({ oracleId: r.oracleId, name: r.name, typeLine: r.typeLine, colorIdentity: r.colorIdentity }))
}

/**
 * A single commander candidate for lookup scoring: oracle metadata plus the
 * user's availability for it (0/0 when they don't own it). Null when the
 * oracle id doesn't exist in the catalog.
 */
export async function loadCommanderCandidate(
  supabase: SupabaseClient,
  userId: string,
  oracleId: string,
): Promise<OwnedOracleCard | null> {
  const { data: oracleData, error: oracleError } = await supabase
    .from('co_card_oracle')
    .select(ORACLE_COLUMNS)
    .eq('oracle_id', oracleId)
    .maybeSingle()
  if (oracleError) throw new Error(`Commander lookup failed: ${oracleError.message}`)
  if (!oracleData) return null
  const meta = toOracleRow(oracleData as Record<string, unknown>)

  const [{ data: availData, error: availError }, { data: tagData, error: tagError }] = await Promise.all([
    supabase
      .from('co_card_availability')
      .select('owned_qty, free_qty')
      .eq('user_id', userId)
      .eq('oracle_id', oracleId)
      .maybeSingle(),
    supabase.from('co_card_tags').select('tag, weight').eq('oracle_id', oracleId),
  ])
  if (availError) throw new Error(`Availability lookup failed: ${availError.message}`)
  if (tagError) throw new Error(`Tag lookup failed: ${tagError.message}`)

  return {
    oracleId: meta.oracleId,
    name: meta.name,
    typeLine: meta.typeLine,
    oracleText: meta.oracleText,
    colorIdentity: meta.colorIdentity,
    keywords: meta.keywords,
    cmc: meta.cmc,
    ownedQty: Number(availData?.owned_qty ?? 0),
    freeQty: Number(availData?.free_qty ?? 0),
    tags: (tagData ?? []).map((t) => ({ tag: t.tag as OwnedOracleCard['tags'][number]['tag'], weight: Number(t.weight) || 1 })),
  }
}

export interface GapBuyCard {
  oracleId: string
  name: string
  priceEur: number | null
}

/**
 * For each shortfall bucket in a DeckProposal's gapBuckets, up to two cheap
 * cards the user doesn't own that would fill the gap: tagged `bucket` in
 * co_card_tags, within the commander's colour identity, cheapest-first.
 *
 * 'creatures' and 'filler' are skipped — neither is a co_card_tags tag.
 * 'creatures' membership in deck-generator is type-line based (isCreature),
 * and 'filler' is deck-generator's leftover-fill pass, not a tag/type rule —
 * there's nothing to query co_card_tags for in either case.
 */
export async function findGapBuys(
  supabase: SupabaseClient,
  userId: string,
  commanderIdentity: string[],
  gapBuckets: { bucket: ProposalBucket; shortfall: number }[],
): Promise<{ bucket: ProposalBucket; buys: GapBuyCard[] }[]> {
  const availability = await loadAvailability(supabase, userId)
  const owned = new Set(availability.map((a) => a.oracleId))

  const out: { bucket: ProposalBucket; buys: GapBuyCard[] }[] = []
  for (const { bucket } of gapBuckets) {
    if (bucket === 'creatures' || bucket === 'filler') continue

    const { data: tagRows, error: tagError } = await supabase
      .from('co_card_tags')
      .select('oracle_id')
      .eq('tag', bucket)
      .order('weight', { ascending: false })
      .limit(GAP_BUY_OVERFETCH)
    if (tagError) throw new Error(`Gap buy tag lookup failed (${bucket}): ${tagError.message}`)

    const candidateIds = (tagRows ?? []).map((r) => r.oracle_id as string).filter((id) => !owned.has(id))
    if (candidateIds.length === 0) {
      out.push({ bucket, buys: [] })
      continue
    }

    // co_card_tags is not FK-embeddable with co_card_oracle (it's a view) — hand-join,
    // same pattern as loadTags/loadOracleMeta above. candidateIds is already ≤ GAP_BUY_OVERFETCH
    // (well under IN_CHUNK), so a single .in() call is safe without chunking.
    const { data: oracleRows, error: oracleError } = await supabase
      .from('co_card_oracle')
      .select('oracle_id, name, color_identity, prices')
      .in('oracle_id', candidateIds)
    if (oracleError) throw new Error(`Gap buy oracle lookup failed (${bucket}): ${oracleError.message}`)

    const buys = (oracleRows ?? [])
      .map((r) => {
        const prices = r.prices as Record<string, string> | null
        return {
          oracleId: r.oracle_id as string,
          name: r.name as string,
          colorIdentity: (r.color_identity as string[]) ?? [],
          priceEur: prices?.eur ? Number(prices.eur) : null,
        }
      })
      .filter((c) => fitsColorIdentity(c.colorIdentity, commanderIdentity))
      .sort((a, b) => {
        const pa = a.priceEur ?? Infinity
        const pb = b.priceEur ?? Infinity
        return pa - pb || a.name.localeCompare(b.name)
      })
      .slice(0, GAP_BUY_TAKE)
      .map(({ oracleId, name, priceEur }) => ({ oracleId, name, priceEur }))

    out.push({ bucket, buys })
  }
  return out
}
