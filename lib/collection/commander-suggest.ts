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

function computeCompleteness(buckets: BucketCoverage[]): number {
  const weightByBucket = new Map(IDEAL_PROFILE.map((p) => [p.bucket, p.weight]))
  const sum = buckets.reduce((acc, b) => {
    const weight = weightByBucket.get(b.bucket) ?? 0
    return acc + weight * (Math.min(b.owned, b.ideal) / b.ideal)
  }, 0)
  return round1(sum * 100)
}

// Card types/supertypes that can appear after a dash on an MDFC/DFC back
// face's own type prefix and must never be mistaken for a creature subtype.
const CARD_TYPE_STOPWORDS = new Set(
  [
    'Legendary', 'Creature', 'Artifact', 'Enchantment', 'Land', 'Planeswalker',
    'Instant', 'Sorcery', 'Battle', 'Snow', 'Basic', 'Token', 'World', 'Kindred',
  ].map((w) => w.toLowerCase()),
)

/**
 * Creature subtypes present on a card's type line. Double-faced/MDFC type
 * lines pack two faces into one string ("Creature — A // Creature — B") — a
 * naive single split on the dash grabs everything between the FIRST and
 * SECOND dash, which bleeds the back face's own type words ("Creature", a
 * stray "//") into the front face's subtypes and drops the back face's real
 * subtypes entirely (bug-1395: produced a nonsense "15 Creatures tie into
 * this commander's tribal theme"). Fix: split into faces on ' // ' first,
 * parse each face's subtypes independently, and filter out card
 * types/supertypes and any '/'-containing token.
 */
function subtypesOf(c: { typeLine: string }): string[] {
  return c.typeLine.split(' // ').flatMap((face) => {
    const after = face.split(/[—-]/)[1] ?? ''
    return after
      .trim()
      .split(/\s+/)
      .filter((w) => w && !w.includes('/') && !CARD_TYPE_STOPWORDS.has(w.toLowerCase()))
  })
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Word forms a creature subtype can take in oracle text. Beyond the naive
 * "+s"/"+es", MTG tribal types commonly pluralize irregularly — Elf→Elves,
 * Wolf→Wolves, Dwarf→Dwarves (f/fe→ves) and Harpy→Harpies (consonant+y→ies) —
 * so a bare "+s" rule would miss real tribal payoffs like Elvish Archdruid.
 */
function tribalWordForms(subtype: string): string[] {
  const forms = new Set<string>([subtype, `${subtype}s`, `${subtype}es`, pluralizeSubtype(subtype)])
  return [...forms]
}

/**
 * The single preferred plural for a creature subtype, for PROSE display
 * (Elf → Elves, Harpy → Harpies, Bear → Bears) — same irregular rules as
 * tribalWordForms above (f/fe→ves, consonant+y→ies) but one best guess
 * instead of the full set of forms tribalWordForms matches oracle text
 * against.
 */
export function pluralizeSubtype(subtype: string): string {
  if (/fe?$/i.test(subtype)) return `${subtype.replace(/fe?$/i, '')}ves`
  if (/[^aeiou]y$/i.test(subtype)) return `${subtype.slice(0, -1)}ies`
  return `${subtype}s`
}

// Per-card facts, derived once per input collection instead of re-derived
// for every (candidate × pool card) pair — suggestCommanders scores every
// eligible commander against the whole collection, so re-splitting type
// lines/regexing tags per candidate was O(candidates × collection) with a
// non-trivial constant (perf verification measured ~2.4s on a 5451-card
// collection vs the <1s target). isBasic/isCreature/tags/subtypes/keywords
// only depend on the card itself, never on which commander is being scored.
type CardFacts = {
  card: OwnedOracleCard
  isBasic: boolean
  isCreature: boolean
  tagSet: Set<SynergyTag>
  subtypes: string[]
  keywordSet: Set<string>
}

function buildCardFacts(collection: OwnedOracleCard[]): CardFacts[] {
  return collection.map((card) => ({
    card,
    isBasic: isBasic(card),
    isCreature: isCreature(card),
    tagSet: new Set(card.tags.map((t) => t.tag)),
    subtypes: subtypesOf(card),
    keywordSet: new Set(card.keywords.map((k) => k.toLowerCase())),
  }))
}

function buildPoolFacts(commander: CommanderCandidate, facts: CardFacts[], opts: SuggestOptions): CardFacts[] {
  return facts.filter(
    (f) =>
      f.card.oracleId !== commander.oracleId &&
      !f.isBasic &&
      (opts.freeOnly ? f.card.freeQty > 0 : f.card.ownedQty > 0) &&
      fitsColorIdentity(f.card.colorIdentity, commander.colorIdentity),
  )
}

function computeBucketsFromFacts(pool: CardFacts[]): BucketCoverage[] {
  const countByTag = (tag: SynergyTag) => pool.reduce((n, f) => n + (f.tagSet.has(tag) ? 1 : 0), 0)
  const owned: Record<BucketCoverage['bucket'], number> = {
    ramp: countByTag('ramp'),
    card_draw: countByTag('card_draw'),
    removal: countByTag('removal'),
    board_wipe: countByTag('board_wipe'),
    creatures: pool.reduce((n, f) => n + (f.isCreature ? 1 : 0), 0),
    filler: pool.length,
  }
  return IDEAL_PROFILE.map(({ bucket, ideal }) => ({ bucket, owned: owned[bucket], ideal }))
}

function computeTribalFactFromFacts(pool: CardFacts[], commanderOracleText: string): { type: string; count: number } | null {
  const countBySubtype = new Map<string, number>()
  for (const f of pool) {
    if (!f.isCreature) continue
    for (const subtype of f.subtypes) {
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

function computeKeywordOverlapFromFacts(pool: CardFacts[], commanderKeywords: string[]): string[] {
  return commanderKeywords.filter((kw) => {
    const kwLower = kw.toLowerCase()
    const count = pool.reduce((n, f) => n + (f.keywordSet.has(kwLower) ? 1 : 0), 0)
    return count >= KEYWORD_OVERLAP_MIN
  })
}

function scoreCommanderWithFacts(commander: CommanderCandidate, facts: CardFacts[], opts: SuggestOptions): CommanderSuggestion {
  const pool = buildPoolFacts(commander, facts, opts)
  const lockedCount = pool.reduce((n, f) => n + (f.card.freeQty === 0 ? 1 : 0), 0)

  const buckets = computeBucketsFromFacts(pool)
  const completeness = computeCompleteness(buckets)

  const tribal = computeTribalFactFromFacts(pool, commander.oracleText)
  const keywordOverlap = computeKeywordOverlapFromFacts(pool, commander.keywords)

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

export function scoreCommander(
  commander: CommanderCandidate,
  collection: OwnedOracleCard[],
  opts: SuggestOptions,
): CommanderSuggestion {
  return scoreCommanderWithFacts(commander, buildCardFacts(collection), opts)
}

export function suggestCommanders(collection: OwnedOracleCard[], opts: SuggestOptions): CommanderSuggestion[] {
  const facts = buildCardFacts(collection)
  const candidates = collection.filter((c) => {
    if (!isCommanderEligible(c.typeLine, c.oracleText)) return false
    return opts.freeOnly ? c.freeQty > 0 : c.ownedQty > 0
  })
  return candidates
    .map((c) => scoreCommanderWithFacts(c, facts, opts))
    .sort((a, b) => b.score - a.score || a.commander.name.localeCompare(b.commander.name))
}
