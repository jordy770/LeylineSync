// fitCardColumns — the spotlight board's "how many columns make N cards fit
// this panel" math (lib/game/spotlight-fit). Pure; aspect 2:3, gap in px.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitCardColumns, partitionSpotlightCards } from '../../lib/game/spotlight-fit'
import type { BoardCard } from '../../lib/game/types'

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

let seq = 0
function card(over: Partial<BoardCard>): BoardCard {
  seq += 1
  return {
    id: `c${seq}`,
    card_id: `cat${seq}`,
    name: 'Test Card',
    is_tapped: false,
    damage_marked: 0,
    position_x: 0,
    position_y: 0,
    zone: 'battlefield' as BoardCard['zone'],
    image_url: null,
    type_line: 'Creature — Test',
    ...over,
  }
}
const land = (over: Partial<BoardCard> = {}) => card({ name: 'Forest', type_line: 'Basic Land — Forest', ...over })

test('plain lands collapse into the chip counts and produce no tiles', () => {
  const p = partitionSpotlightCards([land(), land(), land({ is_tapped: true })])
  assert.equal(p.tiles.length, 0)
  assert.equal(p.landTotal, 3)
  assert.equal(p.landOpen, 2)
})

test('badged lands stay as tiles but still count in the chip', () => {
  const animated = land({ animated: true })
  const damaged = land({ damage_marked: 2 })
  const aura = card({ name: 'Utopia Sprawl', type_line: 'Enchantment — Aura', attached_to: 'host-land' })
  const host = land({ id: 'host-land' })
  const p = partitionSpotlightCards([animated, damaged, host, aura, land()])
  // animated + damaged + enchanted host stay; the aura itself stays (attached);
  // the last plain Forest collapses.
  assert.deepEqual(p.tiles.map((t) => t.card.id), [animated.id, damaged.id, 'host-land', aura.id])
  assert.equal(p.landTotal, 4)
})

test('identical plain duplicates stack with a count, split by tapped state', () => {
  const a = card({ name: 'Soldier Token', is_token: true })
  const b = card({ name: 'Soldier Token', is_token: true })
  const tapped = card({ name: 'Soldier Token', is_token: true, is_tapped: true })
  const p = partitionSpotlightCards([a, b, tapped])
  assert.equal(p.tiles.length, 2)
  assert.deepEqual(p.tiles[0], { card: a, count: 2 })
  assert.deepEqual(p.tiles[1], { card: tapped, count: 1 })
})

test('cards with counters, damage, attachments or face-down never stack', () => {
  const pumped = card({ name: 'Bear', plus_one_counters: 1 })
  const plain = card({ name: 'Bear' })
  const quest = card({ name: 'Shrine', counters: { charge: 3 } })
  const shrine = card({ name: 'Shrine' })
  const down = card({ name: 'Morph', is_face_down: true })
  const down2 = card({ name: 'Morph', is_face_down: true })
  const p = partitionSpotlightCards([pumped, plain, quest, shrine, down, down2])
  assert.equal(p.tiles.length, 6)
  assert.ok(p.tiles.every((t) => t.count === 1))
})

test('legendary permanents (commander guard) never stack', () => {
  const cmdr = card({ name: 'Yshtola', type_line: 'Legendary Creature — Human Wizard' })
  const copy = card({ name: 'Yshtola', type_line: 'Legendary Creature — Human Wizard' })
  const p = partitionSpotlightCards([cmdr, copy])
  assert.equal(p.tiles.length, 2)
})

test('order is preserved and a stack sits at its first copy', () => {
  const bear1 = card({ name: 'Bear' })
  const elf = card({ name: 'Elf' })
  const bear2 = card({ name: 'Bear' })
  const p = partitionSpotlightCards([bear1, elf, bear2])
  assert.deepEqual(p.tiles.map((t) => [t.card.name, t.count]), [['Bear', 2], ['Elf', 1]])
})
