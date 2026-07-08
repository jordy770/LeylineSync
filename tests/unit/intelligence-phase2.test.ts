// Intelligence Engine phase 2 — the pure deck analyzer (role counts +
// structured issues) and the conflict arbiter (explained value ranking).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyCard } from '../../lib/intelligence/card-engine'
import { arbitrateConflict } from '../../lib/intelligence/conflict-arbiter'
import { analyzeDeckRoles, type DeckCard } from '../../lib/intelligence/deck-analyzer'

const card = (over: Partial<DeckCard>): DeckCard => ({
  name: 'Test Card',
  typeLine: 'Creature — Human',
  oracleText: null,
  keywords: [],
  cmc: 3,
  quantity: 1,
  ...over,
})

const forest = card({ name: 'Forest', typeLine: 'Basic Land — Forest', oracleText: '{T}: Add {G}.', cmc: 0 })
const rock = card({ name: 'Mana Stone', typeLine: 'Artifact', oracleText: '{T}: Add {C}.', cmc: 2 })
const draw = card({ name: 'Divination-ish', typeLine: 'Sorcery', oracleText: 'Draw two cards.', cmc: 3 })
const kill = card({ name: 'Murder-ish', typeLine: 'Instant', oracleText: 'Destroy target creature.', cmc: 3 })

test('analyzeDeckRoles counts mana sources and diagnoses gaps with confidence', () => {
  const deck = [
    { ...forest, quantity: 30 },
    { ...rock, quantity: 2 },
    { ...card({ name: 'Vanilla', oracleText: null, cmc: 5 }), quantity: 40 },
  ]
  const intel = analyzeDeckRoles(deck)

  assert.equal(intel.landCount, 30)
  assert.equal(intel.manaSources, 32) // 30 lands + 2 rocks
  const ids = intel.issues.map((i) => i.id)
  assert.ok(ids.includes('low-draw'))
  assert.ok(ids.includes('low-interaction'))
  assert.ok(ids.includes('few-lands'))
  const lowDraw = intel.issues.find((i) => i.id === 'low-draw')!
  assert.ok(lowDraw.confidence >= 0.8) // zero draw = high confidence
  assert.ok(lowDraw.recommendedRoles.includes('card_draw'))
})

test('a well-built deck raises fewer issues', () => {
  const deck = [
    { ...forest, quantity: 36 },
    { ...rock, quantity: 5 },
    { ...card({ name: 'Elfje', typeLine: 'Creature — Elf Druid', oracleText: '{T}: Add {G}.', cmc: 1 }), quantity: 5 },
    { ...draw, quantity: 10 },
    { ...kill, quantity: 8 },
    { ...card({ name: 'Wipe', typeLine: 'Sorcery', oracleText: 'Destroy all creatures.', cmc: 4 }), quantity: 3 },
    { ...card({ name: 'Filler', cmc: 2 }), quantity: 33 },
  ]
  const intel = analyzeDeckRoles(deck)
  assert.ok(!intel.issues.some((i) => ['low-draw', 'low-ramp', 'low-interaction', 'few-wipes', 'few-lands'].includes(i.id)),
    `unexpected issues: ${intel.issues.map((i) => i.id).join(', ')}`)
})

test('the arbiter prefers the deck whose commander wants the card AND whose gap it fills', () => {
  const rhystic = classifyCard({
    name: 'Rhystic Study', typeLine: 'Enchantment',
    oracleText: 'Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.',
    keywords: [], cmc: 3,
  })

  const verdict = arbitrateConflict(rhystic, [
    {
      id: 'a', name: 'Talrand Spells', commanderName: 'Talrand, Sky Summoner',
      issues: [{ id: 'low-draw', issue: '', detail: '', confidence: 0.9, recommendedRoles: ['card_draw', 'draw_engine'] }],
    },
    {
      id: 'b', name: 'Kaalia Angels', commanderName: 'Kaalia of the Vast',
      issues: [],
    },
  ])

  assert.equal(verdict.bestDeckId, 'a')
  const winner = verdict.ranking[0]
  assert.ok(winner.value > verdict.ranking[1].value)
  assert.ok(winner.reasons.some((r) => r.includes('gap')))
})

test('an unprofiled commander with no gaps still gets an honest reason', () => {
  const vanilla = classifyCard({ name: 'X', typeLine: 'Creature', oracleText: null, keywords: [], cmc: 2 })
  const verdict = arbitrateConflict(vanilla, [
    { id: 'a', name: 'Mystery Deck', commanderName: 'Unknown Commander', issues: [] },
  ])
  assert.equal(verdict.ranking[0].value, 0)
  assert.match(verdict.ranking[0].reasons[0], /no profiled synergy/)
})
