// Buildable commanders (phase 1) — deterministic scoring of "which commander
// decks can this collection support". Pure functions; the server loader feeds
// OwnedOracleCard shapes in, the Advisor renders CommanderSuggestion out.
// Spec: docs/superpowers/specs/2026-07-29-buildable-commanders-design.md

import type { SynergyTag } from './synergy/tagger'
import { fitsColorIdentity } from './upgrade-scanner'

export type OwnedOracleCard = {
  oracleId: string
  name: string
  typeLine: string
  oracleText: string
  colorIdentity: string[] // e.g. ['G','W']
  keywords: string[]
  ownedQty: number
  freeQty: number
  tags: { tag: SynergyTag; weight: number }[]
}
export type CommanderCandidate = OwnedOracleCard // lookup mode may pass ownedQty/freeQty 0
export type SuggestOptions = { freeOnly: boolean }
export type BucketCoverage = {
  bucket: 'ramp' | 'card_draw' | 'removal' | 'board_wipe' | 'creatures' | 'filler'
  owned: number
  ideal: number
}
export type ThemeFacts = { tribal: { type: string; count: number } | null; keywordOverlap: string[] }
export type CommanderSuggestion = {
  commander: { oracleId: string; name: string; colorIdentity: string[] }
  score: number // completeness*0.8 + themeBoost, 1 decimal
  completeness: number // 0-100
  themeBoost: number // 0-20 (capped)
  ownedPlayable: number // nonbasic in-identity pool size (excl. commander)
  lockedCount: number // pool cards only available from existing decks
  buckets: BucketCoverage[]
  themeFacts: ThemeFacts
  ownsCommander: boolean
  commanderIsFree: boolean
}

export const IDEAL_PROFILE: { bucket: BucketCoverage['bucket']; ideal: number; weight: number }[] = [
  { bucket: 'ramp', ideal: 10, weight: 0.2 },
  { bucket: 'card_draw', ideal: 10, weight: 0.2 },
  { bucket: 'removal', ideal: 8, weight: 0.15 },
  { bucket: 'board_wipe', ideal: 3, weight: 0.05 },
  { bucket: 'creatures', ideal: 25, weight: 0.25 },
  { bucket: 'filler', ideal: 63, weight: 0.15 },
]

const TRIBAL_KEYWORD_MIN = 5
const KEYWORD_OVERLAP_MIN = 8
const TRIBAL_BOOST_CAP = 15
const KEYWORD_BOOST_PER = 2.5
const KEYWORD_BOOST_CAP = 5
const THEME_BOOST_CAP = 20
const round1 = (x: number) => Math.round(x * 10) / 10

export function isCommanderEligible(typeLine: string, oracleText: string): boolean {
  if (/legendary/i.test(typeLine) && /creature/i.test(typeLine)) return true
  return /can be your commander/i.test(oracleText)
}

const isBasic = (c: { typeLine: string }) => /basic land/i.test(c.typeLine)
const isCreature = (c: { typeLine: string }) => /creature/i.test(c.typeLine)

function buildPool(commander: CommanderCandidate, collection: OwnedOracleCard[], opts: SuggestOptions): OwnedOracleCard[] {
  return collection.filter(
    (c) =>
      c.oracleId !== commander.oracleId &&
      !isBasic(c) &&
      (opts.freeOnly ? c.freeQty > 0 : c.ownedQty > 0) &&
      fitsColorIdentity(c.colorIdentity, commander.colorIdentity),
  )
}

function computeBuckets(pool: OwnedOracleCard[]): BucketCoverage[] {
  const countByTag = (tag: SynergyTag) => pool.filter((c) => c.tags.some((t) => t.tag === tag)).length
  const owned: Record<BucketCoverage['bucket'], number> = {
    ramp: countByTag('ramp'),
    card_draw: countByTag('card_draw'),
    removal: countByTag('removal'),
    board_wipe: countByTag('board_wipe'),
    creatures: pool.filter(isCreature).length,
    filler: pool.length,
  }
  return IDEAL_PROFILE.map(({ bucket, ideal }) => ({ bucket, owned: owned[bucket], ideal }))
}

function computeCompleteness(buckets: BucketCoverage[]): number {
  const weightByBucket = new Map(IDEAL_PROFILE.map((p) => [p.bucket, p.weight]))
  const sum = buckets.reduce((acc, b) => {
    const weight = weightByBucket.get(b.bucket) ?? 0
    return acc + weight * (Math.min(b.owned, b.ideal) / b.ideal)
  }, 0)
  return round1(sum * 100)
}

/** Creature subtypes present on a card's type line (after the em-dash/hyphen). */
function subtypesOf(c: { typeLine: string }): string[] {
  const after = c.typeLine.split(/[—-]/)[1] ?? ''
  return after.trim().split(/\s+/).filter(Boolean)
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Word forms a creature subtype can take in oracle text. Beyond the naive
 * "+s"/"+es", MTG tribal types commonly pluralize irregularly — Elf→Elves,
 * Wolf→Wolves, Dwarf→Dwarves (f/fe→ves) and Harpy→Harpies (consonant+y→ies) —
 * so a bare "+s" rule would miss real tribal payoffs like Elvish Archdruid.
 */
function tribalWordForms(subtype: string): string[] {
  const forms = new Set<string>([subtype, `${subtype}s`, `${subtype}es`])
  if (/fe?$/i.test(subtype)) {
    forms.add(`${subtype.replace(/fe?$/i, '')}ves`)
  }
  if (/[^aeiou]y$/i.test(subtype)) {
    forms.add(`${subtype.slice(0, -1)}ies`)
  }
  return [...forms]
}

function computeTribalFact(pool: OwnedOracleCard[], commanderOracleText: string): { type: string; count: number } | null {
  const countBySubtype = new Map<string, number>()
  for (const c of pool.filter(isCreature)) {
    for (const subtype of subtypesOf(c)) {
      countBySubtype.set(subtype, (countBySubtype.get(subtype) ?? 0) + 1)
    }
  }
  let best: { type: string; count: number } | null = null
  for (const [subtype, count] of countBySubtype) {
    if (count < TRIBAL_KEYWORD_MIN) continue
    const re = new RegExp('\\b(' + tribalWordForms(subtype).map(escapeRegex).join('|') + ')\\b', 'i')
    if (!re.test(commanderOracleText)) continue
    if (!best || count > best.count) best = { type: subtype, count }
  }
  return best
}

function computeKeywordOverlap(pool: OwnedOracleCard[], commanderKeywords: string[]): string[] {
  return commanderKeywords.filter((kw) => {
    const count = pool.filter((c) => c.keywords.some((k) => k.toLowerCase() === kw.toLowerCase())).length
    return count >= KEYWORD_OVERLAP_MIN
  })
}

export function scoreCommander(
  commander: CommanderCandidate,
  collection: OwnedOracleCard[],
  opts: SuggestOptions,
): CommanderSuggestion {
  const pool = buildPool(commander, collection, opts)
  const lockedCount = pool.filter((c) => c.freeQty === 0).length

  const buckets = computeBuckets(pool)
  const completeness = computeCompleteness(buckets)

  const tribal = computeTribalFact(pool, commander.oracleText)
  const keywordOverlap = computeKeywordOverlap(pool, commander.keywords)

  const tribalBoost = tribal ? (Math.min(tribal.count, 30) / 30) * TRIBAL_BOOST_CAP : 0
  const keywordBoost = Math.min(keywordOverlap.length * KEYWORD_BOOST_PER, KEYWORD_BOOST_CAP)
  const themeBoost = Math.min(tribalBoost + keywordBoost, THEME_BOOST_CAP)

  const score = round1(completeness * 0.8 + themeBoost)

  return {
    commander: { oracleId: commander.oracleId, name: commander.name, colorIdentity: commander.colorIdentity },
    score,
    completeness,
    themeBoost: round1(themeBoost),
    ownedPlayable: pool.length,
    lockedCount,
    buckets,
    themeFacts: { tribal, keywordOverlap },
    ownsCommander: commander.ownedQty > 0,
    commanderIsFree: commander.freeQty > 0,
  }
}

export function suggestCommanders(collection: OwnedOracleCard[], opts: SuggestOptions): CommanderSuggestion[] {
  const candidates = collection.filter((c) => {
    if (!isCommanderEligible(c.typeLine, c.oracleText)) return false
    return opts.freeOnly ? c.freeQty > 0 : c.ownedQty > 0
  })
  return candidates
    .map((c) => scoreCommander(c, collection, opts))
    .sort((a, b) => b.score - a.score || a.commander.name.localeCompare(b.commander.name))
}
