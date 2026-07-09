// Upgrade scanner — the headline feature. Given a deck's needs (from the power
// score) and the player's collection, it proposes:
//   * FREE upgrades   — cards in the binder that fill a need, paired with a weaker
//                       same-role card to cut (a swap) or recommended as additions.
//   * OCCUPIED upgrades — cards the player owns that fit, but which are locked in
//                       another deck (with a "move" hint).
// Buy suggestions (cards not owned) are a later layer.
//
// The selection logic is pure and unit-tested; the orchestrator at the bottom does
// the Supabase I/O and feeds it.

import type { SupabaseClient } from '@supabase/supabase-js'

import { IN_CHUNK, loadAvailability, loadBinderNames, loadDeckForScoring, loadOracleMeta, loadTags, oneToOne } from './deck-loader'
import { computePowerScore } from './power-score'
import type { DeckNeed, PowerScore } from './power-score'
import {
  buildDeckContext,
  commanderSynergy,
  confidence,
  curveFit,
  themeImpact,
} from './scoring'
import type { DeckContext, ThemeImpact } from './scoring'
import type { CardTag, SynergyTag } from './synergy/tagger'

const MAX_PER_CATEGORY = 20
const MAX_PER_TAG = 4

// Default context for callers (and tests) that don't supply deck context — no
// commander / no theme, so confidence falls back to role + need + curve only.
const NO_CONTEXT: DeckContext = { commanderTags: [], hasCommander: false, themeTags: new Set(), avgMv: 0 }

export interface UpgradeCandidate {
  oracleId: string
  name: string
  cmc: number
  priceEur: number | null
  tags: CardTag[]
  usedBy?: DeckRef[]
}

export interface DeckRef {
  id: string
  name: string
}

export interface InDeckCard {
  oracleId: string
  name: string
  tags: CardTag[]
  priceEur?: number | null
}

export interface FreeUpgrade {
  in: { oracleId: string; name: string; priceEur: number | null }
  out: { oracleId: string; name: string } | null
  tag: SynergyTag
  inWeight: number
  delta: number
  confidence: number
  themeImpact: ThemeImpact
  commanderSynergy: number
  binderNames?: string[]
  reason: string
}

export interface OccupiedUpgrade {
  in: { oracleId: string; name: string; priceEur: number | null }
  tag: SynergyTag
  weight: number
  confidence: number
  themeImpact: ThemeImpact
  commanderSynergy: number
  usedBy: DeckRef[]
  action: 'move' | 'buy'
  reason: string
}

function weightFor(tags: CardTag[], tag: SynergyTag): number {
  return tags.find((t) => t.tag === tag)?.weight ?? 0
}

function tagLabel(tag: SynergyTag): string {
  return tag.replace(/_/g, ' ')
}

// Per-tag index of in-deck cards (ascending weight) so we can find the weakest
// same-role card to cut for a given incoming upgrade.
function indexInDeck(inDeck: InDeckCard[]): Map<SynergyTag, { oracleId: string; name: string; weight: number }[]> {
  const byTag = new Map<SynergyTag, { oracleId: string; name: string; weight: number }[]>()
  for (const c of inDeck) {
    for (const { tag, weight } of c.tags) {
      const list = byTag.get(tag) ?? []
      list.push({ oracleId: c.oracleId, name: c.name, weight })
      byTag.set(tag, list)
    }
  }
  for (const list of byTag.values()) list.sort((a, b) => a.weight - b.weight)
  return byTag
}

// Candidate-level fit (no replacement yet) — used to rank the pool before picking.
function candidateConfidence(
  cand: UpgradeCandidate,
  need: DeckNeed,
  ctx: DeckContext,
  availability: 'free' | 'occupied',
): number {
  const roleWeight = weightFor(cand.tags, need.tag)
  return confidence({
    needGap: need.gap,
    target: need.target,
    roleWeight,
    replacementDelta: roleWeight,
    commanderSynergy: commanderSynergy(cand.tags, ctx.commanderTags),
    themeImpact: themeImpact(cand.tags, ctx.themeTags),
    curveFit: curveFit(cand.cmc, ctx.avgMv),
    availability,
    hasCommander: ctx.hasCommander,
  })
}

function matchedThemeTag(tags: CardTag[], themeTags: Set<SynergyTag>): SynergyTag | null {
  for (const t of tags) if (themeTags.has(t.tag)) return t.tag
  return null
}

// A factual one-liner of WHY (the AI turns this into prose). Concrete: role gap,
// commander synergy, theme fit.
function buildNote(cand: UpgradeCandidate, ctx: DeckContext, impact: ThemeImpact): string {
  const parts: string[] = []
  if (ctx.hasCommander && commanderSynergy(cand.tags, ctx.commanderTags) >= 0.5) parts.push('strong commander synergy')
  const mt = matchedThemeTag(cand.tags, ctx.themeTags)
  if (impact === 'Keeps Theme' && mt) parts.push(`fits your ${tagLabel(mt)} theme`)
  else if (impact === 'Weakens Theme') parts.push('a bit off your deck theme')
  return parts.length ? ` — ${parts.join(', ')}` : ''
}

export function buildFreeUpgrades(
  needs: DeckNeed[],
  candidates: UpgradeCandidate[],
  inDeck: InDeckCard[],
  ctx: DeckContext = NO_CONTEXT,
): FreeUpgrade[] {
  const byTag = indexInDeck(inDeck)
  const usedCandidate = new Set<string>()
  const usedOut = new Set<string>()
  const result: FreeUpgrade[] = []

  for (const need of needs) {
    if (result.length >= MAX_PER_CATEGORY) break
    // Rank by fit (commander/theme/curve/role), not raw weight — the best-FITTING
    // card for this deck surfaces, not just the statistically strongest.
    const pool = candidates
      .filter((c) => !usedCandidate.has(c.oracleId) && weightFor(c.tags, need.tag) > 0)
      .sort((a, b) => candidateConfidence(b, need, ctx, 'free') - candidateConfidence(a, need, ctx, 'free') || priceAsc(a, b))

    let addedForTag = 0
    for (const cand of pool) {
      if (result.length >= MAX_PER_CATEGORY || addedForTag >= MAX_PER_TAG) break
      const inWeight = weightFor(cand.tags, need.tag)
      const impact = themeImpact(cand.tags, ctx.themeTags)
      const cmdSyn = commanderSynergy(cand.tags, ctx.commanderTags)

      // Weakest in-deck same-role card strictly weaker than the candidate.
      const cut = (byTag.get(need.tag) ?? []).find((c) => c.weight < inWeight && !usedOut.has(c.oracleId))
      const delta = cut ? inWeight - cut.weight : inWeight
      const conf = confidence({
        needGap: need.gap,
        target: need.target,
        roleWeight: inWeight,
        replacementDelta: delta,
        commanderSynergy: cmdSyn,
        themeImpact: impact,
        curveFit: curveFit(cand.cmc, ctx.avgMv),
        availability: 'free',
        hasCommander: ctx.hasCommander,
      })
      const note = buildNote(cand, ctx, impact)

      result.push({
        in: { oracleId: cand.oracleId, name: cand.name, priceEur: cand.priceEur },
        out: cut ? { oracleId: cut.oracleId, name: cut.name } : null,
        tag: need.tag,
        inWeight,
        delta,
        confidence: conf,
        themeImpact: impact,
        commanderSynergy: Math.round(cmdSyn * 100),
        reason: cut
          ? `Over ${cut.name}: ${tagLabel(need.tag)} ${inWeight} vs ${cut.weight}${note}.`
          : `Fills ${tagLabel(need.tag)} (deck ${need.have}/${need.target})${note}.`,
      })
      if (cut) usedOut.add(cut.oracleId)
      usedCandidate.add(cand.oracleId)
      addedForTag += 1
    }
  }

  return result.sort((a, b) => b.confidence - a.confidence)
}

export function buildOccupiedUpgrades(
  needs: DeckNeed[],
  candidates: UpgradeCandidate[],
  ctx: DeckContext = NO_CONTEXT,
): OccupiedUpgrade[] {
  const used = new Set<string>()
  const result: OccupiedUpgrade[] = []

  for (const need of needs) {
    if (result.length >= MAX_PER_CATEGORY) break
    const pool = candidates
      .filter((c) => !used.has(c.oracleId) && weightFor(c.tags, need.tag) > 0)
      .sort((a, b) => candidateConfidence(b, need, ctx, 'occupied') - candidateConfidence(a, need, ctx, 'occupied'))

    let addedForTag = 0
    for (const cand of pool) {
      if (result.length >= MAX_PER_CATEGORY || addedForTag >= MAX_PER_TAG) break
      const usedBy = cand.usedBy ?? []
      const weight = weightFor(cand.tags, need.tag)
      const impact = themeImpact(cand.tags, ctx.themeTags)
      const cmdSyn = commanderSynergy(cand.tags, ctx.commanderTags)
      result.push({
        in: { oracleId: cand.oracleId, name: cand.name, priceEur: cand.priceEur },
        tag: need.tag,
        weight,
        confidence: confidence({
          needGap: need.gap,
          target: need.target,
          roleWeight: weight,
          replacementDelta: weight,
          commanderSynergy: cmdSyn,
          themeImpact: impact,
          curveFit: curveFit(cand.cmc, ctx.avgMv),
          availability: 'occupied',
          hasCommander: ctx.hasCommander,
        }),
        themeImpact: impact,
        commanderSynergy: Math.round(cmdSyn * 100),
        usedBy,
        action: usedBy.length === 1 ? 'move' : 'buy',
        reason: `Fills ${tagLabel(need.tag)} — owned, but in ${usedBy.map((d) => d.name).join(', ') || 'another deck'}${buildNote(cand, ctx, impact)}.`,
      })
      used.add(cand.oracleId)
      addedForTag += 1
    }
  }

  return result.sort((a, b) => b.confidence - a.confidence)
}

function priceAsc(a: UpgradeCandidate, b: UpgradeCandidate): number {
  return (a.priceEur ?? Infinity) - (b.priceEur ?? Infinity)
}

/** colorIdentity ⊆ deckIdentity */
export function fitsColorIdentity(cardIdentity: string[], deckIdentity: string[]): boolean {
  return cardIdentity.every((c) => deckIdentity.includes(c))
}

// ───────────────────────── Orchestrator (I/O) ─────────────────────────

/** One row of the deck's own list — so the deck page can SHOW the deck. */
export interface DeckListCard {
  oracleId: string
  name: string
  qty: number
  typeLine: string
  cmc: number
  isCommander: boolean
  priceEur: number | null
}

export interface UpgradeScanResult {
  deckId: string
  power: PowerScore
  free: FreeUpgrade[]
  occupied: OccupiedUpgrade[]
  deckList: DeckListCard[]
}

export async function scanDeckUpgrades(
  supabase: SupabaseClient,
  userId: string,
  deckId: string,
): Promise<{ result?: UpgradeScanResult; error?: string }> {
  const { found, deckIdentity, deckOracleIds, scoreCards, inDeck, targetOverrides } = await loadDeckForScoring(supabase, deckId)
  if (!found) return { error: 'Deck not found.' }

  // scoreCards and inDeck are built index-aligned by loadDeckForScoring.
  const deckList: DeckListCard[] = scoreCards.map((c, i) => ({
    oracleId: c.oracleId,
    name: inDeck[i]?.name ?? c.oracleId,
    qty: c.quantity,
    typeLine: c.typeLine,
    cmc: c.cmc,
    isCommander: c.isCommander,
    priceEur: inDeck[i]?.priceEur ?? null,
  }))

  const power = computePowerScore(scoreCards, targetOverrides)
  if (power.needs.length === 0) {
    return { result: { deckId, power, free: [], occupied: [], deckList } }
  }
  // Commander + theme + curve context, so suggestions are ranked on deck FIT.
  const ctx = buildDeckContext(scoreCards, power.avgMv)

  // Candidate pool: everything the user owns, with availability split (paged —
  // an un-ranged select capped the pool at 1000 uniques, bug-1116).
  let avail
  try {
    avail = await loadAvailability(supabase, userId)
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not load collection.' }
  }

  const ownedOracleIds = avail.map((a) => a.oracleId).filter((id) => !deckOracleIds.has(id))
  if (ownedOracleIds.length === 0) {
    return { result: { deckId, power, free: [], occupied: [], deckList } }
  }

  const meta = await loadOracleMeta(supabase, ownedOracleIds)
  const candTags = await loadTags(supabase, ownedOracleIds)

  const freeCands: UpgradeCandidate[] = []
  const occupiedOracleIds: string[] = []
  for (const a of avail) {
    const oracleId = a.oracleId
    if (deckOracleIds.has(oracleId)) continue
    const m = meta.get(oracleId)
    if (!m || !fitsColorIdentity(m.colorIdentity, deckIdentity)) continue
    const candidate: UpgradeCandidate = {
      oracleId,
      name: m.name,
      cmc: m.cmc,
      priceEur: m.priceEur,
      tags: candTags.get(oracleId) ?? [],
    }
    if (a.freeQty > 0) {
      freeCands.push(candidate)
    } else if (a.committedQty > 0) {
      occupiedOracleIds.push(oracleId)
    }
  }

  // Where in the binder each free candidate physically sits (for "go find it").
  const binderNames = await loadBinderNames(supabase, userId, freeCands.map((c) => c.oracleId))

  const usedByMap = await loadUsedBy(supabase, userId, deckId, occupiedOracleIds)
  const occupiedCands: UpgradeCandidate[] = occupiedOracleIds
    .map((oracleId) => {
      const m = meta.get(oracleId)!
      return {
        oracleId,
        name: m.name,
        cmc: m.cmc,
        priceEur: m.priceEur,
        tags: candTags.get(oracleId) ?? [],
        usedBy: usedByMap.get(oracleId) ?? [],
      }
    })
    .filter((c) => fitsColorIdentity(meta.get(c.oracleId)!.colorIdentity, deckIdentity))

  return {
    result: {
      deckId,
      power,
      free: buildFreeUpgrades(power.needs, freeCands, inDeck, ctx).map((f) => ({
        ...f,
        binderNames: binderNames.get(f.in.oracleId) ?? [],
      })),
      occupied: buildOccupiedUpgrades(power.needs, occupiedCands, ctx),
      deckList,
    },
  }
}

async function loadUsedBy(
  supabase: SupabaseClient,
  userId: string,
  excludeDeckId: string,
  oracleIds: string[],
): Promise<Map<string, DeckRef[]>> {
  const out = new Map<string, DeckRef[]>()
  if (oracleIds.length === 0) return out
  for (let i = 0; i < oracleIds.length; i += IN_CHUNK) {
    const chunk = oracleIds.slice(i, i + IN_CHUNK)
    const { data, error } = await supabase
      .from('co_deck_cards')
      .select('oracle_id, co_decks!inner(name, user_id, id)')
      .in('oracle_id', chunk)
    if (error) throw new Error(`Used-by load failed: ${error.message}`)
    for (const r of data ?? []) {
      const deck = oneToOne(r.co_decks)
      if (!deck || deck.user_id !== userId || deck.id === excludeDeckId) continue
      const list = out.get(r.oracle_id as string) ?? []
      list.push({ id: deck.id as string, name: deck.name as string })
      out.set(r.oracle_id as string, list)
    }
  }
  return out
}
