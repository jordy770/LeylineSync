// fitCardColumns — the spotlight board's "how many columns make N cards fit
// this panel" math (lib/game/spotlight-fit). Pure; aspect 2:3, gap in px.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitCardColumns } from '../../lib/game/spotlight-fit'

test('7 cards in a 900x620 panel fit at 5 columns', () => {
  // cols=4 → cardW 216, cardH 324, 2 rows → 660 > 620. cols=5 → cardW 170.4,
  // cardH 255.6, 2 rows → 523.2 ≤ 620.
  assert.equal(fitCardColumns(900, 620, 7, 12), 5)
})

test('22 cards in a 900x620 panel fit at 8 columns', () => {
  // cols=7 → 4 rows of 177.4 + gaps = 745.7 > 620. cols=8 → 3 rows of 153
  // + gaps = 483 ≤ 620.
  assert.equal(fitCardColumns(900, 620, 22, 12), 8)
})

test('a single card on a wide short panel gets extra columns so it fits the height', () => {
  // cols=1 → 900w/1350h, cols=2 → 444/666: both taller than 620.
  // cols=3 → 292/438 fits. Empty columns are the mechanism that shrinks cards.
  assert.equal(fitCardColumns(900, 620, 1, 12), 3)
})

test('result always fits the height (or hit the 8px give-up floor)', () => {
  for (let count = 1; count <= 40; count++) {
    const cols = fitCardColumns(900, 620, count, 12)
    const cardW = (900 - (cols - 1) * 12) / cols
    const rows = Math.ceil(count / cols)
    const totalH = rows * cardW * 1.5 + (rows - 1) * 12
    assert.ok(totalH <= 620 || cardW <= 8, `count=${count} cols=${cols} totalH=${totalH}`)
  }
})

test('columns are monotonically non-decreasing in card count', () => {
  let prev = 0
  for (let count = 1; count <= 30; count++) {
    const cols = fitCardColumns(900, 620, count, 12)
    assert.ok(cols >= prev, `count=${count}: ${cols} < ${prev}`)
    prev = cols
  }
})

test('degenerate inputs return 1 column', () => {
  assert.equal(fitCardColumns(900, 620, 0, 12), 1)
  assert.equal(fitCardColumns(0, 620, 5, 12), 1)
  assert.equal(fitCardColumns(900, 0, 5, 12), 1)
})

test('impossible panel returns the give-up floor instead of looping forever', () => {
  // 100px wide, 10px tall, 50 cards: nothing real fits; must still return.
  const cols = fitCardColumns(100, 10, 50, 8)
  assert.ok(Number.isFinite(cols) && cols >= 1)
})
