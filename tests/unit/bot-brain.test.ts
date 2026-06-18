// bot-brain — the AI CPU's pure heuristic decisions (lib/game/bot-brain). Each
// function is exercised in isolation so the bot's play quality is verifiable.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  shouldMulligan,
  chooseBottom,
  decideMainPlays,
  decideAttacks,
  decideBlocks,
  type BotCard,
  type Creature,
} from '../../lib/game/bot-brain'

const land = (id: string): BotCard => ({ id, typeLine: 'Basic Land — Forest', manaValue: 0 })
const spell = (id: string, mv: number): BotCard => ({ id, typeLine: 'Creature — Bear', manaValue: mv })

// ── shouldMulligan ──────────────────────────────────────────────────────────
test('mulligans a one-lander', () => {
  assert.equal(shouldMulligan(['Land', 'Creature', 'Creature', 'Creature', 'Creature', 'Creature', 'Creature'], 0), true)
})
test('mulligans a six-land flood', () => {
  assert.equal(shouldMulligan(['Land', 'Land', 'Land', 'Land', 'Land', 'Land', 'Creature'], 0), true)
})
test('keeps a healthy 3-land hand', () => {
  assert.equal(shouldMulligan(['Land', 'Land', 'Land', 'Creature', 'Creature', 'Creature', 'Creature'], 0), false)
})
test('keeps anything after two mulligans (no death spiral)', () => {
  assert.equal(shouldMulligan(['Creature', 'Creature', 'Creature', 'Creature', 'Creature'], 2), false)
})

// ── chooseBottom ────────────────────────────────────────────────────────────
test('bottoms nothing when n is 0', () => {
  assert.deepEqual(chooseBottom([land('a'), spell('b', 3)], 0), [])
})
test('bottoms excess lands first on a flood', () => {
  const hand = [land('l1'), land('l2'), land('l3'), land('l4'), land('l5'), spell('s1', 2)]
  assert.deepEqual(chooseBottom(hand, 2), ['l4', 'l5'])
})
test('bottoms the priciest spell when land count is fine', () => {
  const hand = [land('l1'), land('l2'), land('l3'), spell('cheap', 1), spell('pricey', 6)]
  assert.deepEqual(chooseBottom(hand, 1), ['pricey'])
})

// ── decideMainPlays ─────────────────────────────────────────────────────────
test('plays a land and casts cheapest-first within budget', () => {
  // 2 untapped sources + the land drop → budget 3. Should cast the 1 then the 2 (=3), not the 4.
  const hand = [land('L'), spell('one', 1), spell('two', 2), spell('four', 4)]
  const plan = decideMainPlays(hand, 2, true)
  assert.equal(plan.playLandId, 'L')
  assert.deepEqual(plan.castIds, ['one', 'two'])
})
test('does not play a land when no drop available', () => {
  const plan = decideMainPlays([land('L'), spell('one', 1)], 1, false)
  assert.equal(plan.playLandId, null)
  assert.deepEqual(plan.castIds, ['one'])
})
test('casts the commander first when affordable, then fills with hand spells', () => {
  // budget 5 (4 lands + drop). Commander costs 3 → cast it, leaving 2 for the 2-drop.
  const hand = [land('L'), spell('two', 2), spell('four', 4)]
  const plan = decideMainPlays(hand, 4, true, { id: 'cmdr', manaValue: 3 })
  assert.equal(plan.castCommanderId, 'cmdr')
  assert.deepEqual(plan.castIds, ['two'])
})
test('skips the commander when its taxed cost exceeds the budget', () => {
  const plan = decideMainPlays([land('L')], 2, true, { id: 'cmdr', manaValue: 7 })
  assert.equal(plan.castCommanderId, undefined)
})

// ── decideAttacks ───────────────────────────────────────────────────────────
const c = (id: string, p: number, t: number): Creature => ({ id, power: p, toughness: t })

test('swings with everything into an empty board', () => {
  // No blockers → every attacker connects, lethal or not.
  const mine = [c('a', 3, 3), c('b', 4, 4)]
  assert.deepEqual(decideAttacks(mine, [], 40), ['a', 'b'])
})
test('attacks when no blocker can free-kill', () => {
  // 3/3 into a 2/2: the 2/2 dies and the 3/3 lives → no free kill → attack.
  assert.deepEqual(decideAttacks([c('a', 3, 3)], [c('x', 2, 2)], 20), ['a'])
})
test('holds back a lone creature the opponent can free-kill', () => {
  // 2/2 into a 3/3, and they can block it → free kill → don't attack.
  assert.deepEqual(decideAttacks([c('a', 2, 2)], [c('x', 3, 3)], 20), [])
})
test('swings the whole team when it outnumbers the blockers', () => {
  // Three 2/2s vs one 3/3: the 3/3 can only block (and free-kill) one — the other
  // two connect. Pressure beats stalling, so attack with all three.
  assert.deepEqual(
    decideAttacks([c('a', 2, 2), c('b', 2, 2), c('d', 2, 2)], [c('x', 3, 3)], 20),
    ['a', 'b', 'd'],
  )
})

// ── decideBlocks ────────────────────────────────────────────────────────────
test('takes a value block (kill and survive)', () => {
  // my 3/3 blocks a 2/2: kills it (3>=2) and survives (3>2).
  const assign = decideBlocks([c('atk', 2, 2)], [c('blk', 3, 3)], 20)
  assert.deepEqual(assign, { blk: 'atk' })
})
test('does not chump when not dying', () => {
  // 5/5 attacker, I have a 1/1 and 20 life → no value block, no lethal → no block.
  const assign = decideBlocks([c('atk', 5, 5)], [c('blk', 1, 1)], 20)
  assert.deepEqual(assign, {})
})
test('chumps the biggest attacker to survive lethal', () => {
  // 6 + 2 incoming = 8 ≥ 5 life. Chump the 6/6 with the 1/1 → incoming 2 < 5.
  const assign = decideBlocks([c('big', 6, 6), c('small', 2, 2)], [c('chump', 1, 1)], 5)
  assert.deepEqual(assign, { chump: 'big' })
})
