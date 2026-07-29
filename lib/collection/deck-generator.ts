// Deck proposal generator (buildable commanders, phase 2) — deterministic
// 99-card proposal (62 nonland + 37 land) built greedily from the user's
// collection for a chosen commander. Pure; no I/O, no LLM, no Math.random/Date.
// Spec: docs/superpowers/specs/2026-07-29-deck-generation-design.md

import {
  buildCardFacts,
  pluralizeSubtype,
  type CardFacts,
  type CommanderCandidate,
  type OwnedOracleCard,
  type SuggestOptions,
} from './commander-suggest'
import { commanderSynergy } from './scoring'
import { fitsColorIdentity } from './upgrade-scanner'
import type { SynergyTag } from './synergy/tagger'

export type BasicName = 'Plains' | 'Island' | 'Swamp' | 'Mountain' | 'Forest' | 'Wastes'
export type ProposalBucket = 'ramp' | 'card_draw' | 'removal' | 'board_wipe' | 'creatures' | 'filler'
export type ProposalCard = { oracleId: string; name: string; bucket: ProposalBucket; reasons: string[] }
export type DeckProposal = {
  cards: ProposalCard[] // exactly the chosen nonlands, bucket order
  ownedLands: { oracleId: string; name: string }[]
  basics: Partial<Record<BasicName, number>>
  gapBuckets: { bucket: ProposalBucket; shortfall: number }[]
  totals: { nonland: number; ownedLand: number; basicLand: number } // nonland + ownedLand + basicLand ≤ 99
}

const NONLAND_TARGET = 62
const LAND_TARGET = 37
const CURVE_BRAKE_CMC = 6
const CURVE_BRAKE_PENALTY = -1

// Fixed fill order + capacities, mirroring commander-suggest's IDEAL_PROFILE
// minus 'filler' — filler is the leftover-fill pass below, not a bucket with
// its own tag/type membership rule.
const BUCKET_PROFILE: { bucket: Exclude<ProposalBucket, 'filler'>; ideal: number }[] = [
  { bucket: 'ramp', ideal: 10 },
  { bucket: 'card_draw', ideal: 10 },
  { bucket: 'removal', ideal: 8 },
  { bucket: 'board_wipe', ideal: 3 },
  { bucket: 'creatures', ideal: 25 },
]

const BASIC_BY_COLOR: Record<string, BasicName> = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' }

const isLand = (c: { typeLine: string }) => /land/i.test(c.typeLine)
const isBasicLand = (c: { typeLine: string }) => /basic land/i.test(c.typeLine)
const anyColorLand = (c: { oracleText: string }) => /add (one|\w+) mana of any color/i.test(c.oracleText)
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Same pool rules as phase-1's buildPoolFacts (identity subset, basics
// excluded, freeOnly vs whole-collection, commander excluded) — deliberately
// duplicated rather than imported since that helper isn't exported and this
// module's "pool" further splits into land/nonland below.
function poolFacts(commander: CommanderCandidate, facts: CardFacts[], opts: SuggestOptions): CardFacts[] {
  return facts.filter(
    (f) =>
      f.card.oracleId !== commander.oracleId &&
      !isBasicLand(f.card) &&
      (opts.freeOnly ? f.card.freeQty > 0 : f.card.ownedQty > 0) &&
      fitsColorIdentity(f.card.colorIdentity, commander.colorIdentity),
  )
}

// Per-card "does this care about the commander's theme" fact used both for
// the reason chips and the within-bucket/filler score. Tribal hit: does the
// commander's own oracle text mention (singular or the pluralizeSubtype
// plural, word-boundary, case-insensitive) any subtype this card has? This
// is deliberately a simpler per-card check than phase-1's aggregate
// TRIBAL_KEYWORD_MIN-gated tribal fact (that logic isn't exported, and a
// per-card reason chip doesn't need a collection-wide threshold).
function themeMatchFor(f: CardFacts, commander: CommanderCandidate): { tribalType: string | null; keywordHits: string[]; score: number } {
  let tribalType: string | null = null
  for (const subtype of f.subtypes) {
    const forms = [subtype, pluralizeSubtype(subtype)].map(escapeRegex)
    const re = new RegExp(`\\b(${forms.join('|')})\\b`, 'i')
    if (re.test(commander.oracleText)) {
      tribalType = subtype
      break
    }
  }
  const keywordHits = commander.keywords.filter((k) => f.keywordSet.has(k.toLowerCase()))
  const score = (tribalType ? 2 : 0) + keywordHits.length
  return { tribalType, keywordHits, score }
}

function tagWeightFor(f: CardFacts, bucket: ProposalBucket): number {
  if (bucket === 'creatures' || bucket === 'filler') return 0
  let weight = 0
  for (const t of f.card.tags) if (t.tag === bucket) weight = Math.max(weight, t.weight)
  return weight
}

// Within-bucket / filler score: tagWeight + themeMatch + commanderSynergy
// (design spec §2), plus a curve brake applied only during filler ranking.
function scoreFor(f: CardFacts, bucket: ProposalBucket, commander: CommanderCandidate, applyCurveBrake: boolean): number {
  const theme = themeMatchFor(f, commander)
  const synergy = commanderSynergy(f.card.tags, commander.tags)
  const tagWeight = tagWeightFor(f, bucket)
  const brake = applyCurveBrake && (f.card.cmc ?? 0) > CURVE_BRAKE_CMC ? CURVE_BRAKE_PENALTY : 0
  return tagWeight + theme.score + synergy + brake
}

function rankedFor(list: CardFacts[], bucket: ProposalBucket, commander: CommanderCandidate, applyCurveBrake: boolean): CardFacts[] {
  return list
    .map((f) => ({ f, score: scoreFor(f, bucket, commander, applyCurveBrake) }))
    .sort((a, b) => b.score - a.score || a.f.card.name.localeCompare(b.f.card.name))
    .map((x) => x.f)
}

function reasonsFor(f: CardFacts, bucket: ProposalBucket, commander: CommanderCandidate): string[] {
  const reasons: string[] = [bucket]
  const theme = themeMatchFor(f, commander)
  if (theme.tribalType) reasons.push(`tribal: ${theme.tribalType}`)
  for (const k of theme.keywordHits) reasons.push(`keyword: ${k}`)
  const n = Math.round(commanderSynergy(f.card.tags, commander.tags) * 10)
  if (n > 0) reasons.push(`synergy ${n}`)
  return reasons
}

// Largest-remainder split of `totalBasics` across the commander's identity
// colours, weighted by how many of the CHOSEN nonland cards carry each
// colour in their color_identity (multicolor cards count once per colour
// they carry), with a floor of 1 basic per identity colour. Colourless
// identity → all Wastes (no colours to distribute across).
function computeBasics(identity: string[], chosenNonlands: CardFacts[], totalBasics: number): Partial<Record<BasicName, number>> {
  if (totalBasics <= 0) return {}
  if (identity.length === 0) return { Wastes: totalBasics }

  const counts = new Map<string, number>(identity.map((c) => [c, 0]))
  for (const f of chosenNonlands) {
    for (const c of f.card.colorIdentity) {
      if (counts.has(c)) counts.set(c, (counts.get(c) ?? 0) + 1)
    }
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  const raw = identity.map((color) => {
    const share = total > 0 ? (counts.get(color)! / total) * totalBasics : totalBasics / identity.length
    return { color, floor: Math.floor(share), rem: share - Math.floor(share) }
  })
  const finalCounts = new Map(raw.map((r) => [r.color, r.floor]))
  const allocated = raw.reduce((a, r) => a + r.floor, 0)
  const remainder = totalBasics - allocated
  const byRemainderDesc = [...raw].sort((a, b) => b.rem - a.rem || identity.indexOf(a.color) - identity.indexOf(b.color))
  for (let i = 0; i < remainder; i++) {
    const color = byRemainderDesc[i % byRemainderDesc.length].color
    finalCounts.set(color, (finalCounts.get(color) ?? 0) + 1)
  }
  // Guarantee ≥1 per identity colour, stealing from the current max.
  for (const color of identity) {
    if ((finalCounts.get(color) ?? 0) > 0) continue
    let maxColor = identity[0]
    for (const c of identity) if ((finalCounts.get(c) ?? 0) > (finalCounts.get(maxColor) ?? 0)) maxColor = c
    finalCounts.set(maxColor, (finalCounts.get(maxColor) ?? 0) - 1)
    finalCounts.set(color, 1)
  }

  const basics: Partial<Record<BasicName, number>> = {}
  for (const color of identity) {
    const qty = finalCounts.get(color) ?? 0
    if (qty > 0) basics[BASIC_BY_COLOR[color]] = qty
  }
  return basics
}

export function generateDeckProposal(
  commander: CommanderCandidate,
  collection: OwnedOracleCard[],
  opts: SuggestOptions,
): DeckProposal {
  const facts = buildCardFacts(collection)
  const pool = poolFacts(commander, facts, opts)
  const nonlandPool = pool.filter((f) => !isLand(f.card))
  const landPool = pool.filter((f) => isLand(f.card))

  const remaining = new Map(nonlandPool.map((f) => [f.card.oracleId, f]))
  const cards: ProposalCard[] = []
  const chosenNonlands: CardFacts[] = []
  const bucketCounts: Record<Exclude<ProposalBucket, 'filler'>, number> = {
    ramp: 0,
    card_draw: 0,
    removal: 0,
    board_wipe: 0,
    creatures: 0,
  }

  for (const { bucket, ideal } of BUCKET_PROFILE) {
    const matching = [...remaining.values()].filter((f) =>
      bucket === 'creatures' ? f.isCreature : f.tagSet.has(bucket as SynergyTag),
    )
    const ranked = rankedFor(matching, bucket, commander, false)
    const chosen = ranked.slice(0, ideal)
    for (const f of chosen) {
      cards.push({ oracleId: f.card.oracleId, name: f.card.name, bucket, reasons: reasonsFor(f, bucket, commander) })
      chosenNonlands.push(f)
      remaining.delete(f.card.oracleId)
    }
    bucketCounts[bucket] = chosen.length
  }

  const fillerSlots = Math.max(0, NONLAND_TARGET - cards.length)
  const fillerRanked = rankedFor([...remaining.values()], 'filler', commander, true)
  for (const f of fillerRanked.slice(0, fillerSlots)) {
    cards.push({ oracleId: f.card.oracleId, name: f.card.name, bucket: 'filler', reasons: reasonsFor(f, 'filler', commander) })
    chosenNonlands.push(f)
  }

  const rankedLands = [...landPool].sort((a, b) => {
    const aAny = anyColorLand(a.card) ? 1 : 0
    const bAny = anyColorLand(b.card) ? 1 : 0
    if (aAny !== bAny) return bAny - aAny
    return a.card.name.localeCompare(b.card.name)
  })
  const ownedLandsChosen = rankedLands.slice(0, LAND_TARGET)
  const ownedLands = ownedLandsChosen.map((f) => ({ oracleId: f.card.oracleId, name: f.card.name }))
  const basicLandCount = LAND_TARGET - ownedLands.length

  const basics = computeBasics(commander.colorIdentity, chosenNonlands, basicLandCount)

  const gapBuckets = BUCKET_PROFILE.map(({ bucket, ideal }) => ({
    bucket,
    shortfall: Math.max(0, ideal - bucketCounts[bucket]),
  })).filter((g) => g.shortfall > 0)

  return {
    cards,
    ownedLands,
    basics,
    gapBuckets,
    totals: { nonland: cards.length, ownedLand: ownedLands.length, basicLand: basicLandCount },
  }
}
