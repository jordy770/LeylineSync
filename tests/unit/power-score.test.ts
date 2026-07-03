// Power score — deterministic deck rating from synergy buckets + curve. Builds
// synthetic decks so the math (targets, coverage, needs) is pinned independent of
// the live card pool.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { computePowerScore } from '../../lib/collection/power-score'
import type { DeckCardForScore } from '../../lib/collection/power-score'
import type { SynergyTag } from '../../lib/collection/synergy/tagger'

let n = 0
function card(tags: SynergyTag[], opts: { qty?: number; cmc?: number; land?: boolean } = {}): DeckCardForScore {
  n += 1
  return {
    oracleId: `o-${n}`,
    quantity: opts.qty ?? 1,
    cmc: opts.cmc ?? 2,
    typeLine: opts.land ? 'Land' : 'Creature',
    isCommander: false,
    tags: (opts.land ? ([...tags, 'land'] as SynergyTag[]) : tags).map((t) => ({ tag: t, weight: 1 })),
  }
}

function deck(...cards: DeckCardForScore[]): DeckCardForScore[] {
  return cards
}

test('lands are counted via tag or type, not as nonland curve', () => {
  const s = computePowerScore(deck(card([], { land: true, qty: 37 }), card(['ramp'], { cmc: 1 })))
  assert.equal(s.landCount, 37)
  assert.equal(s.nonlandCount, 1)
  assert.equal(s.curve['1'], 1)
})

test('buckets count quantity-weighted sources', () => {
  const s = computePowerScore(deck(card(['ramp'], { qty: 3 }), card(['ramp', 'card_draw'])))
  assert.equal(s.buckets.ramp, 4)
  assert.equal(s.buckets.card_draw, 1)
})

test('a deck below guidelines lists needs sorted by gap', () => {
  const s = computePowerScore(deck(card([], { land: true, qty: 30 }), card(['ramp'], { qty: 2 })))
  // land gap = 7, ramp gap = 8, card_draw gap = 10, removal 8, wipe 3 → draw first.
  assert.equal(s.needs[0].tag, 'card_draw')
  assert.ok(s.needs.find((x) => x.tag === 'land')?.gap === 7)
  assert.ok(s.power < 6)
})

test('a well-built deck scores high and reports no needs', () => {
  const s = computePowerScore(
    deck(
      card([], { land: true, qty: 37 }),
      card(['ramp'], { qty: 10, cmc: 2 }),
      card(['card_draw'], { qty: 10, cmc: 3 }),
      card(['removal'], { qty: 8, cmc: 2 }),
      card(['board_wipe'], { qty: 3, cmc: 4 }),
    ),
  )
  assert.equal(s.needs.length, 0)
  assert.ok(s.power >= 9, `expected >=9, got ${s.power}`)
  assert.match(s.explanation, /Strengths/)
})

test('high curve drags the score down', () => {
  const low = computePowerScore(deck(card([], { land: true, qty: 37 }), card(['ramp'], { qty: 10, cmc: 2 })))
  const high = computePowerScore(deck(card([], { land: true, qty: 37 }), card(['ramp'], { qty: 10, cmc: 7 })))
  assert.ok(high.avgMv > low.avgMv)
  assert.ok(high.power < low.power)
})

test('empty deck does not divide by zero', () => {
  const s = computePowerScore([])
  assert.equal(s.avgMv, 0)
  assert.equal(s.power, 0)
})
