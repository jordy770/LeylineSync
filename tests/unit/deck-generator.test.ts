// Deck proposal generator (lib/collection/deck-generator) — pure, deterministic
// 62 nonland + 37 land build from the collection for a chosen commander.
// Spec: docs/superpowers/specs/2026-07-29-deck-generation-design.md
// Task brief: .superpowers/sdd/2026-07-29-deck-generation/task-1-brief.md
//
// Every expected value below is HAND-DERIVED from the algorithm rules before
// the implementation exists (module-not-found RED first) — never copied from
// a run of the implementation. Derivations are inline per test.
//
// Note on a doc discrepancy found while deriving fixtures: the design spec
// (docs/superpowers/specs/2026-07-29-deck-generation-design.md §2) gives the
// within-bucket score as `tagWeight + themeMatch + commanderSynergy`, but the
// implementation plan's Global Constraints section says
// `tagWeight + themeMatch + 2×commanderSynergy`. This module implements the
// design-spec's 1x form (see deck-generator.ts). None of the fixtures below
// depend on distinguishing 1x vs 2x — every test that touches ordering holds
// either commanderSynergy equal across the compared candidates or zero, so
// the coefficient never determines an assertion. Flagged in task-1-report.md.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateDeckProposal } from '../../lib/collection/deck-generator'
import type { OwnedOracleCard } from '../../lib/collection/commander-suggest'
import type { SynergyTag } from '../../lib/collection/synergy/tagger'

let n = 0
function card(over: Partial<OwnedOracleCard> = {}): OwnedOracleCard {
  n += 1
  return {
    oracleId: `o-${n}`,
    name: `Card ${n}`,
    typeLine: 'Creature — Human',
    oracleText: '',
    colorIdentity: ['G'],
    keywords: [],
    ownedQty: 1,
    freeQty: 1,
    tags: [],
    cmc: 2,
    ...over,
  }
}
const tag = (t: SynergyTag, weight = 2) => [{ tag: t, weight }]
const cmdr = (over: Partial<OwnedOracleCard> = {}) =>
  card({ name: 'Test General', typeLine: 'Legendary Creature — Elf Druid', colorIdentity: ['G'], tags: [], ...over })

// ── 1. determinism ──────────────────────────────────────────────────────
test('determinism: two calls with identical inputs produce identical proposals', () => {
  const c = cmdr()
  const pool = [
    card({ name: 'Alpha Ramp', typeLine: 'Artifact', tags: tag('ramp') }),
    card({ name: 'Beta Ramp', typeLine: 'Artifact', tags: tag('ramp') }),
    card({ name: 'Gamma Draw', typeLine: 'Sorcery', tags: tag('card_draw') }),
    card({ name: 'Delta Creature', typeLine: 'Creature — Bear' }),
    card({ name: 'Epsilon Land', typeLine: 'Land', oracleText: 'Add one mana of any color.' }),
    card({ name: 'Zeta Land', typeLine: 'Land' }),
  ]
  const collection = [c, ...pool]
  const p1 = generateDeckProposal(c, collection, { freeOnly: true })
  const p2 = generateDeckProposal(c, collection, { freeOnly: true })
  assert.deepEqual(p1, p2)
})

// ── 2. singleton + one-bucket-per-card ──────────────────────────────────
test('singleton: a card tagged both ramp and card_draw appears once, in ramp (first bucket in order)', () => {
  const c = cmdr()
  const dual = card({ name: 'Dual Tag', typeLine: 'Artifact', tags: [{ tag: 'ramp', weight: 2 }, { tag: 'card_draw', weight: 2 }] })
  const proposal = generateDeckProposal(c, [c, dual], { freeOnly: true })
  // ramp is first in the fixed bucket order; the dual-tagged card is consumed
  // there and removed from the remaining pool before card_draw is evaluated.
  assert.equal(proposal.cards.length, 1)
  assert.equal(proposal.cards[0].oracleId, dual.oracleId)
  assert.equal(proposal.cards[0].bucket, 'ramp')
})

// ── 3. bucket capacities ────────────────────────────────────────────────
test('bucket capacities: 12 ramp-tagged cards → exactly 10 in ramp, the other 2 eligible for filler', () => {
  const c = cmdr()
  const ramp = Array.from({ length: 12 }, (_, i) =>
    card({ name: `Ramp ${String(i + 1).padStart(2, '0')}`, typeLine: 'Artifact', tags: tag('ramp') }))
  const proposal = generateDeckProposal(c, [c, ...ramp], { freeOnly: true })
  // All 12 score identically (tagWeight 2, no theme/synergy) → tie-break name
  // asc. ramp ideal=10, so Ramp 01..Ramp 10 fill ramp; Ramp 11/12 aren't
  // creatures (typeLine Artifact) and have no other bucket tag, so with the
  // pool far under the 62 filler target they land in filler.
  const rampCards = proposal.cards.filter((x) => x.bucket === 'ramp')
  const fillerCards = proposal.cards.filter((x) => x.bucket === 'filler')
  assert.equal(rampCards.length, 10)
  assert.equal(fillerCards.length, 2)
  assert.deepEqual(
    rampCards.map((x) => x.name),
    Array.from({ length: 10 }, (_, i) => `Ramp ${String(i + 1).padStart(2, '0')}`),
  )
  assert.deepEqual(fillerCards.map((x) => x.name), ['Ramp 11', 'Ramp 12'])
})

// ── 4. within-bucket ordering ───────────────────────────────────────────
test('within-bucket ordering: higher tag weight wins; ties broken by name asc', () => {
  const c = cmdr()
  const xavier = card({ name: 'Xavier', typeLine: 'Artifact', tags: tag('ramp', 3) })
  const mno = card({ name: 'Mno', typeLine: 'Artifact', tags: tag('ramp', 2) })
  const zulu = card({ name: 'Zulu', typeLine: 'Artifact', tags: tag('ramp', 2) })
  const lima = card({ name: 'Lima', typeLine: 'Artifact', tags: tag('ramp', 1) })
  const proposal = generateDeckProposal(c, [c, xavier, mno, zulu, lima], { freeOnly: true })
  // score = tagWeight (no theme/synergy: commander has no tags/oracleText/keywords).
  // Xavier(3) > {Mno,Zulu}(2) > Lima(1). Mno/Zulu tie on weight → name asc:
  // 'Mno' < 'Zulu'. Expected order: Xavier, Mno, Zulu, Lima.
  assert.deepEqual(
    proposal.cards.map((x) => x.name),
    ['Xavier', 'Mno', 'Zulu', 'Lima'],
  )
})

// ── 5. tribal/keyword/synergy reasons ───────────────────────────────────
test('reasons: tribal + keyword + synergy present on a matching card, absent on a plain one', () => {
  const c = cmdr({ oracleText: 'Other Elves you control get +1/+1.', keywords: ['Trample'], tags: tag('ramp') })
  const elf = card({ name: 'Elf One', typeLine: 'Creature — Elf', tags: tag('ramp'), keywords: ['Trample'] })
  const plain = card({ name: 'Plain Two', typeLine: 'Sorcery' })
  const proposal = generateDeckProposal(c, [c, elf, plain], { freeOnly: true })
  // elf: subtypes=['Elf'] (single-face type line, token after the dash).
  // pluralizeSubtype('Elf') = 'Elves' (f-ending rule) and the commander's
  // oracle text contains "Elves" → tribal hit 'Elf'. keywordHits: commander
  // keywords ['Trample'] ∩ elf.keywords ['Trample'] → 'Trample'.
  // commanderSynergy(elf.tags=[{ramp,2}], c.tags=[{ramp,2}]) = matched 2 /
  // total 2 = 1.0 → n = round(1.0*10) = 10 > 0 → 'synergy 10'.
  // elf is tagged ramp → bucket 'ramp' is reason[0].
  const elfCard = proposal.cards.find((x) => x.oracleId === elf.oracleId)!
  assert.deepEqual(elfCard.reasons, ['ramp', 'tribal: Elf', 'keyword: Trample', 'synergy 10'])
  // plain: no tags (typeLine Sorcery has no subtypes, no dash token), no
  // keywords, commanderSynergy([], [{ramp,2}]) = matched 0/total 2 = 0 →
  // n=0 → excluded. It has no bucket tag and isn't a creature → filler.
  const plainCard = proposal.cards.find((x) => x.oracleId === plain.oracleId)!
  assert.deepEqual(plainCard.reasons, ['filler'])
})

// ── 6. curve brake ──────────────────────────────────────────────────────
test('curve brake: two otherwise-equal filler candidates, cmc 7 vs cmc 3 → cmc 3 chosen first', () => {
  const c = cmdr()
  const high = card({ name: 'Aaa High', typeLine: 'Sorcery', cmc: 7 })
  const low = card({ name: 'Bbb Low', typeLine: 'Sorcery', cmc: 3 })
  const proposal = generateDeckProposal(c, [c, high, low], { freeOnly: true })
  // Both are untagged/non-creature → filler. No theme/synergy (commander has
  // no tags/oracleText/keywords) → score is curve-brake only: high has
  // cmc 7 > 6 → score -1; low has cmc 3 → score 0. Score desc: low before
  // high, even though 'Aaa High' would sort first alphabetically without
  // the brake.
  assert.deepEqual(
    proposal.cards.map((x) => x.name),
    ['Bbb Low', 'Aaa High'],
  )
})

// ── 7. 62/37 split ──────────────────────────────────────────────────────
test('62/37 split: a big enough pool fills to nonland 62, remainder split owned/basic lands', () => {
  const c = cmdr({ colorIdentity: ['G'] })
  const fillers = Array.from({ length: 62 }, (_, i) =>
    card({ name: `Filler ${String(i + 1).padStart(2, '0')}`, typeLine: 'Artifact', colorIdentity: ['G'] }))
  const lands = ['Land A', 'Land B', 'Land C'].map((name) => card({ name, typeLine: 'Land', colorIdentity: [] }))
  const proposal = generateDeckProposal(c, [c, ...fillers, ...lands], { freeOnly: true })
  // No ramp/card_draw/removal/board_wipe/creature-tagged cards exist, so all
  // five profile buckets fill 0 and the 62 fillers fill the whole nonland
  // target exactly. 3 owned (nonbasic, in-identity via empty colorIdentity)
  // lands are all kept (3 ≤ 37); the remaining 37-3=34 land slots are basics.
  assert.equal(proposal.cards.length, 62)
  assert.equal(proposal.ownedLands.length, 3)
  assert.deepEqual(proposal.totals, { nonland: 62, ownedLand: 3, basicLand: 34 })
})

// ── 8. owned land ranking ───────────────────────────────────────────────
test('owned lands ranked any-colour producers first, then name asc', () => {
  const c = cmdr({ colorIdentity: ['G'] })
  const landZ = card({ name: 'Zzz Basic Dual', typeLine: 'Land', colorIdentity: [] })
  const landA = card({ name: 'Aaa Basic Dual', typeLine: 'Land', colorIdentity: [] })
  const landAny = card({ name: 'Mmm Any Color', typeLine: 'Land', colorIdentity: [], oracleText: 'Add one mana of any color.' })
  const proposal = generateDeckProposal(c, [c, landZ, landA, landAny], { freeOnly: true })
  // 'Mmm Any Color' matches the any-colour oracle-text regex and ranks
  // first regardless of name; the remaining two tie-break alphabetically:
  // 'Aaa Basic Dual' < 'Zzz Basic Dual'.
  assert.deepEqual(
    proposal.ownedLands.map((l) => l.name),
    ['Mmm Any Color', 'Aaa Basic Dual', 'Zzz Basic Dual'],
  )
})

// ── 9. basics distribution (largest remainder) ──────────────────────────
test('basics distribution: 3 W-identity + 1 U-identity nonlands, 0 owned lands → 37 basics 28/9', () => {
  const c = cmdr({ colorIdentity: ['W', 'U'] })
  const wCards = ['W One', 'W Two', 'W Three'].map((name) => card({ name, typeLine: 'Artifact', colorIdentity: ['W'] }))
  const uCard = card({ name: 'U One', typeLine: 'Artifact', colorIdentity: ['U'] })
  const proposal = generateDeckProposal(c, [c, ...wCards, uCard], { freeOnly: true })
  // 0 owned lands → basicLand = 37. Chosen-nonland colour counts: W=3, U=1,
  // total=4. Raw shares: W = 3/4*37 = 27.75 (floor 27, remainder .75),
  // U = 1/4*37 = 9.25 (floor 9, remainder .25). Floors sum to 36, 1 seat
  // left over → goes to the larger remainder (W, .75 > .25) → W=28, U=9.
  // This is exactly the brief's stated "3:1 largest-remainder split of 37".
  assert.equal(proposal.totals.ownedLand, 0)
  assert.deepEqual(proposal.basics, { Plains: 28, Island: 9 })
})

// ── 10. colourless commander → Wastes ───────────────────────────────────
test('colourless commander identity → all basics are Wastes', () => {
  const c = cmdr({ colorIdentity: [] })
  const proposal = generateDeckProposal(c, [c], { freeOnly: true })
  // No pool cards at all (only the commander, which is excluded) → 0 owned
  // lands → basicLand = 37, all Wastes since the commander's identity is
  // colourless (no W/U/B/R/G to distribute across).
  assert.equal(proposal.totals.basicLand, 37)
  assert.deepEqual(proposal.basics, { Wastes: 37 })
})

// ── 11. gapBuckets ───────────────────────────────────────────────────────
test('gapBuckets: a pool with only 4 ramp cards reports shortfalls for all 5 profile buckets, never filler', () => {
  const c = cmdr({ colorIdentity: ['G'] })
  const ramp = Array.from({ length: 4 }, (_, i) => card({ name: `Ramp ${i + 1}`, typeLine: 'Artifact', tags: tag('ramp') }))
  const proposal = generateDeckProposal(c, [c, ...ramp], { freeOnly: true })
  // ramp: ideal 10, 4 assigned → shortfall 6. card_draw/removal/board_wipe:
  // ideal 10/8/3, 0 assigned (no tagged cards) → shortfall = ideal. creatures:
  // ideal 25, 0 assigned (the 4 ramp cards are typeLine Artifact, not
  // creatures, and no other creature cards exist) → shortfall 25.
  assert.deepEqual(proposal.gapBuckets, [
    { bucket: 'ramp', shortfall: 6 },
    { bucket: 'card_draw', shortfall: 10 },
    { bucket: 'removal', shortfall: 8 },
    { bucket: 'board_wipe', shortfall: 3 },
    { bucket: 'creatures', shortfall: 25 },
  ])
  assert.ok(!proposal.gapBuckets.some((g) => g.bucket === 'filler'))
})

// ── 12. freeOnly semantics ──────────────────────────────────────────────
test('freeOnly: locked cards excluded in freeOnly, included otherwise', () => {
  const c = cmdr()
  const free = card({ name: 'Free Card', typeLine: 'Artifact' })
  const locked = card({ name: 'Locked Card', typeLine: 'Artifact', freeQty: 0 })
  const propFree = generateDeckProposal(c, [c, free, locked], { freeOnly: true })
  const propAll = generateDeckProposal(c, [c, free, locked], { freeOnly: false })
  assert.deepEqual(propFree.cards.map((x) => x.name), ['Free Card'])
  assert.deepEqual(propAll.cards.map((x) => x.name).sort(), ['Free Card', 'Locked Card'])
})
