// Buildable-commanders scoring (lib/collection/commander-suggest) — pure,
// deterministic: completeness over IDEAL_PROFILE buckets + capped theme boost.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isCommanderEligible,
  scoreCommander,
  suggestCommanders,
  type OwnedOracleCard,
} from '../../lib/collection/commander-suggest'
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
    ...over,
  }
}
const tag = (t: SynergyTag) => [{ tag: t, weight: 2 }]
const cmdr = (over: Partial<OwnedOracleCard> = {}) =>
  card({ name: 'Test General', typeLine: 'Legendary Creature — Elf Druid', colorIdentity: ['G'], ...over })

test('eligibility: legendary creatures and "can be your commander" cards', () => {
  assert.equal(isCommanderEligible('Legendary Creature — Elf', ''), true)
  assert.equal(isCommanderEligible('Creature — Elf', ''), false)
  assert.equal(isCommanderEligible('Legendary Planeswalker — Teferi', 'Teferi can be your commander.'), true)
  assert.equal(isCommanderEligible('Legendary Enchantment', ''), false)
})

test('pool respects color identity and excludes basics and the commander itself', () => {
  const c = cmdr()
  const inColor = card({ tags: tag('ramp') })
  const offColor = card({ colorIdentity: ['R'] })
  const basic = card({ name: 'Forest', typeLine: 'Basic Land — Forest' })
  const s = scoreCommander(c, [c, inColor, offColor, basic], { freeOnly: true })
  assert.equal(s.ownedPlayable, 1)
})

test('freeOnly excludes cards locked in decks; whole-collection counts them as locked', () => {
  const c = cmdr()
  const free = card({})
  const locked = card({ freeQty: 0 })
  const sFree = scoreCommander(c, [free, locked], { freeOnly: true })
  const sAll = scoreCommander(c, [free, locked], { freeOnly: false })
  assert.equal(sFree.ownedPlayable, 1)
  assert.equal(sFree.lockedCount, 0)
  assert.equal(sAll.ownedPlayable, 2)
  assert.equal(sAll.lockedCount, 1)
})

test('completeness follows the ideal profile weights', () => {
  const c = cmdr()
  // Exactly the ramp ideal (10 ramp cards), nothing else: creatures bucket also
  // counts them (they are creatures), filler counts all 10.
  const pool = Array.from({ length: 10 }, () => card({ tags: tag('ramp') }))
  const s = scoreCommander(c, pool, { freeOnly: true })
  // ramp 10/10*0.20 + creatures 10/25*0.25 + filler 10/63*0.15 = 0.2+0.1+0.0238 → 32.4
  assert.equal(s.completeness, 32.4)
})

test('tribal boost fires when the commander names a subtype you own in bulk', () => {
  const c = cmdr({ oracleText: 'Other Elves you control get +1/+1.' })
  const elves = Array.from({ length: 30 }, () => card({ typeLine: 'Creature — Elf' }))
  const s = scoreCommander(c, elves, { freeOnly: true })
  assert.equal(s.themeFacts.tribal?.type, 'Elf')
  assert.equal(s.themeFacts.tribal?.count, 30)
  assert.equal(s.themeBoost, 15)
})

test('theme boost is capped at 20', () => {
  const c = cmdr({ oracleText: 'Other Elves you control get +1/+1.', keywords: ['Trample', 'Haste'] })
  const elves = Array.from({ length: 30 }, () =>
    card({ typeLine: 'Creature — Elf', keywords: ['Trample', 'Haste'] }))
  const s = scoreCommander(c, elves, { freeOnly: true })
  assert.equal(s.themeBoost, 20) // 15 tribal + 2×2.5 keywords, capped
})

test('lookup mode: an unowned commander scores the same pool, with ownership facts', () => {
  const owned = cmdr()
  const unowned = cmdr({ name: 'Store Shelf General', ownedQty: 0, freeQty: 0 })
  const pool = Array.from({ length: 8 }, () => card({}))
  const a = scoreCommander(owned, pool, { freeOnly: true })
  const b = scoreCommander(unowned, pool, { freeOnly: true })
  assert.equal(a.completeness, b.completeness)
  assert.equal(a.ownsCommander, true)
  assert.equal(b.ownsCommander, false)
  assert.equal(b.commanderIsFree, false)
})

test('suggestCommanders: freeOnly requires a free commander, ordering is deterministic', () => {
  const strong = cmdr({ name: 'Aaa Strong' })
  const lockedCmdr = cmdr({ name: 'Locked General', freeQty: 0 })
  const weak = cmdr({ name: 'Bbb Weak', colorIdentity: ['W'] })
  const pool = Array.from({ length: 12 }, () => card({ tags: tag('ramp') }))
  const sugFree = suggestCommanders([strong, lockedCmdr, weak, ...pool], { freeOnly: true })
  assert.deepEqual(sugFree.map((s) => s.commander.name).slice(0, 2), ['Aaa Strong', 'Bbb Weak'])
  assert.ok(!sugFree.some((s) => s.commander.name === 'Locked General'))
  const sugAll = suggestCommanders([strong, lockedCmdr, weak, ...pool], { freeOnly: false })
  assert.ok(sugAll.some((s) => s.commander.name === 'Locked General'))
})

// Regression for bug-1395: MDFC/DFC type lines pack two faces into one
// string ("Creature — A // Creature — B"). A naive single dash-split bled
// the back face's own type words ("Creature", a stray "//") into the front
// face's subtypes and dropped the back face's real subtypes.
test('MDFC/double-faced type lines yield only real subtypes, one face at a time', () => {
  const c = cmdr({ oracleText: 'Other Angels you control get +1/+1.' })
  const mdfc = Array.from({ length: 6 }, () =>
    card({ typeLine: 'Legendary Creature — Phyrexian Angel // Legendary Creature — Nightmare' }))
  const s = scoreCommander(c, mdfc, { freeOnly: true })
  assert.equal(s.themeFacts.tribal?.type, 'Angel')
  assert.equal(s.themeFacts.tribal?.count, 6)
})

test('the card type "Creature" is never extracted as a tribal subtype', () => {
  const c = cmdr({ oracleText: 'Creatures you control get +1/+1.' })
  const mdfc = Array.from({ length: 6 }, () =>
    card({ typeLine: 'Legendary Creature — Phyrexian Angel // Legendary Creature — Nightmare' }))
  const s = scoreCommander(c, mdfc, { freeOnly: true })
  assert.equal(s.themeFacts.tribal, null)
})
