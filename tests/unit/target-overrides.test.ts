// Per-deck target tuning (mig 384) — the pure engine side: overrides shift the
// needs and the health targets, a 0 target silences a need entirely, and the
// sanitizer only lets known tags with sane values through.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { computePowerScore, sanitizeTargetOverrides } from '../../lib/collection/power-score'
import type { DeckCardForScore } from '../../lib/collection/power-score'

function land(qty: number): DeckCardForScore {
  return { oracleId: `land-${qty}`, quantity: qty, cmc: 0, typeLine: 'Basic Land — Swamp', isCommander: false, tags: [{ tag: 'land', weight: 1 }] }
}
function tagged(tag: string, qty: number): DeckCardForScore {
  return { oracleId: `${tag}-${qty}`, quantity: qty, cmc: 2, typeLine: 'Instant', isCommander: false, tags: [{ tag: tag as never, weight: 2 }] }
}

test('a lower land target silences the land need and relabels health', () => {
  const cards = [land(33), tagged('removal', 8)]
  const before = computePowerScore(cards)
  assert.ok(before.needs.some((n) => n.tag === 'land'), 'default 37-land guideline flags 33 lands')

  const after = computePowerScore(cards, { land: 33 })
  assert.ok(!after.needs.some((n) => n.tag === 'land'), 'tuned target accepts 33 lands')
  const mana = after.health.find((h) => h.axis === 'Mana Base')
  assert.equal(mana?.score, 100)
  assert.match(mana?.explanation ?? '', /33\/33 lands/)
})

test('overriding counterspell ADDS a need the guidelines do not track', () => {
  const cards = [land(37), tagged('ramp', 10), tagged('card_draw', 10), tagged('removal', 8), tagged('board_wipe', 3)]
  assert.equal(computePowerScore(cards).needs.length, 0, 'guidelines fully met')

  const tuned = computePowerScore(cards, { counterspell: 5 })
  const need = tuned.needs.find((n) => n.tag === 'counterspell')
  assert.equal(need?.target, 5)
  assert.equal(need?.gap, 5)
})

test('a target of 0 gives full coverage instead of dividing by zero', () => {
  const cards = [land(37)]
  const tuned = computePowerScore(cards, { ramp: 0, card_draw: 0, removal: 0, board_wipe: 0 })
  assert.ok(!tuned.needs.some((n) => n.tag !== 'land' && n.gap > 0))
})

test('sanitizeTargetOverrides keeps known tags, clamps, and rejects junk', () => {
  assert.equal(sanitizeTargetOverrides(null), null)
  assert.equal(sanitizeTargetOverrides('lands pls'), null)
  assert.equal(sanitizeTargetOverrides({ banana: 5 }), null)
  assert.deepEqual(sanitizeTargetOverrides({ land: 34.6, removal: 999, banana: 5, tutor: -3 }), {
    land: 35,
    removal: 60,
    tutor: 0,
  })
})
