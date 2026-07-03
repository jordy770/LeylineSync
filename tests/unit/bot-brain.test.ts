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

// ── decideAttacks: keywords ──────────────────────────────────────────────────
const ck = (id: string, p: number, t: number, keywords: Creature['keywords']): Creature => ({ id, power: p, toughness: t, keywords })

test('a flier swings past a ground blocker that would otherwise free-kill it', () => {
  // 2/2 flier into a 3/3 with no flying/reach → can't be blocked → connects.
  assert.deepEqual(decideAttacks([ck('f', 2, 2, { flying: true })], [c('g', 3, 3)], 20), ['f'])
})
test('reach blocks a flier, so the flier holds back when free-killed', () => {
  assert.deepEqual(decideAttacks([ck('f', 2, 2, { flying: true })], [ck('r', 3, 3, { reach: true })], 20), [])
})
test('a menace creature swings when the opponent has only one blocker', () => {
  // Menace needs two blockers; with one available it can't be blocked → connects.
  assert.deepEqual(decideAttacks([ck('m', 2, 2, { menace: true })], [c('x', 3, 3)], 20), ['m'])
})
test('holds back a defensive reserve against a lethal swing-back', () => {
  // 2/2 trade is fine, but their 2/2 racing us at 2 life → keep our wall home.
  assert.deepEqual(decideAttacks([c('a', 2, 2)], [c('x', 2, 2)], 20, { myLife: 2 }), [])
})
test('still swings for lethal even when low on life', () => {
  assert.deepEqual(decideAttacks([c('a', 25, 25)], [c('x', 2, 2)], 20, { myLife: 2 }), ['a'])
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

// ── decideBlocks: keywords ────────────────────────────────────────────────────
test('a first-strike blocker value-blocks a same-size attacker (kills before taking damage)', () => {
  // 2/2 first strike vs 2/2: it kills the attacker before the swing-back → free kill.
  assert.deepEqual(decideBlocks([c('atk', 2, 2)], [ck('blk', 2, 2, { firstStrike: true })], 20), { blk: 'atk' })
})
test('a same-size attacker is only a trade without first strike → no value block', () => {
  assert.deepEqual(decideBlocks([c('atk', 2, 2)], [c('blk', 2, 2)], 20), {})
})
test('a deathtouch first-striker free-kills anything it can block', () => {
  assert.deepEqual(decideBlocks([c('atk', 5, 5)], [ck('blk', 1, 1, { deathtouch: true, firstStrike: true })], 20), { blk: 'atk' })
})
test('cannot value-block a flier without flying or reach', () => {
  assert.deepEqual(decideBlocks([ck('atk', 2, 2, { flying: true })], [c('blk', 3, 3)], 20), {})
})
test('a reach blocker can value-block a flier', () => {
  assert.deepEqual(decideBlocks([ck('atk', 2, 2, { flying: true })], [ck('blk', 3, 3, { reach: true })], 20), { blk: 'atk' })
})
test('needs two blockers to chump a menace attacker when dying', () => {
  // One blocker can't legally block menace → no block even at lethal.
  assert.deepEqual(decideBlocks([ck('m', 5, 5, { menace: true })], [c('b1', 1, 1)], 3), {})
  // Two blockers → both commit to the menace attacker.
  assert.deepEqual(decideBlocks([ck('m', 5, 5, { menace: true })], [c('b1', 1, 1), c('b2', 1, 1)], 3), { b1: 'm', b2: 'm' })
})
test('trample leak forces a second chump that a non-trampler would not need', () => {
  // Two 3/3 attackers, 4 life, two 1/1 chumps. The trampler leaks 2 past one
  // chump, so we must also chump the other attacker to live.
  assert.deepEqual(
    decideBlocks([ck('A', 3, 3, { trample: true }), c('B', 3, 3)], [c('b1', 1, 1), c('b2', 1, 1)], 4),
    { b1: 'A', b2: 'B' },
  )
  // Without trample, one chump drops incoming to 3 < 4 → second attacker left open.
  assert.deepEqual(
    decideBlocks([c('A', 3, 3), c('B', 3, 3)], [c('b1', 1, 1), c('b2', 1, 1)], 4),
    { b1: 'A' },
  )
})
