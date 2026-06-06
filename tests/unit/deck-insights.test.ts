// Unit tests for the pure deck-statistics helpers (no DB).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  manaValue,
  deckTypeBreakdown,
  deckColorPips,
  deckManaCurve,
  deckAverageManaValue,
  deckLandCount,
  deckSingletonViolations,
  cardColorIdentity,
  deckColorIdentityViolations,
  deckCardCount,
  commanderDeckLegality,
} from '../../lib/game/deck-insights'
import type { DeckCardLine, LinkedCard } from '../../lib/game/types'

const card = (over: Partial<LinkedCard>): LinkedCard => ({ id: over.id ?? 'x', name: over.name ?? 'Card', ...over })
const line = (c: Partial<LinkedCard>, quantity = 1): DeckCardLine => ({
  card_id: c.id ?? 'x',
  quantity,
  card: card(c),
})

test('manaValue parses generic, coloured, X and hybrid', () => {
  assert.equal(manaValue('{2}{W}{U}'), 4)
  assert.equal(manaValue('{R}'), 1)
  assert.equal(manaValue('{X}{R}'), 1)
  assert.equal(manaValue('{2/W}{2/U}'), 4) // hybrid counts the numeric side
  assert.equal(manaValue('{W/U}'), 1)
  assert.equal(manaValue(null), 0)
})

test('deckTypeBreakdown counts by primary type and quantity', () => {
  const lines = [
    line({ id: 'a', type_line: 'Creature — Goblin' }, 3),
    line({ id: 'b', type_line: 'Basic Land — Mountain' }, 20),
    line({ id: 'c', type_line: 'Legendary Creature — Goblin' }, 1),
    line({ id: 'd', type_line: 'Instant' }, 2),
  ]
  const b = deckTypeBreakdown(lines)
  assert.equal(b.creature, 4)
  assert.equal(b.land, 20)
  assert.equal(b.instant, 2)
})

test('deckColorPips counts each pip times quantity', () => {
  const pips = deckColorPips([line({ mana_cost: '{R}{R}' }, 2), line({ mana_cost: '{W}{U}' }, 1)])
  assert.equal(pips.R, 4)
  assert.equal(pips.W, 1)
  assert.equal(pips.U, 1)
  assert.equal(pips.G, 0)
})

test('deckManaCurve buckets non-lands, lands excluded, 7+ clamps', () => {
  const curve = deckManaCurve([
    line({ mana_cost: '{1}' }, 2), // mv 1
    line({ mana_cost: '{3}{G}' }, 1), // mv 4
    line({ mana_cost: '{8}' }, 1), // mv 8 -> 7+
    line({ type_line: 'Land', mana_cost: null }, 10), // excluded
  ])
  assert.equal(curve[1].count, 2)
  assert.equal(curve[4].count, 1)
  assert.equal(curve[7].label, '7+')
  assert.equal(curve[7].count, 1)
})

test('deckAverageManaValue and deckLandCount', () => {
  const lines = [
    line({ mana_cost: '{2}' }, 1),
    line({ mana_cost: '{4}' }, 1),
    line({ type_line: 'Land' }, 5),
  ]
  assert.equal(deckAverageManaValue(lines), 3) // (2+4)/2
  assert.equal(deckLandCount(lines), 5)
})

test('cardColorIdentity reads mana cost AND rules-text symbols', () => {
  assert.deepEqual([...cardColorIdentity({ mana_cost: '{2}{G}{W}' })].sort(), ['G', 'W'])
  // An activated ability symbol in the rules text counts toward identity.
  assert.deepEqual([...cardColorIdentity({ mana_cost: '{2}', oracle_text: '{T}: Add {R}.' })], ['R'])
  assert.equal(cardColorIdentity({ mana_cost: '{3}' }).size, 0) // colourless
})

test('deckColorIdentityViolations flags off-identity cards vs the commander', () => {
  const commander = card({ mana_cost: '{G}{W}{U}{B}' }) // Atraxa-ish: WUBG
  const v = deckColorIdentityViolations(
    [
      line({ name: 'Lightning Bolt', mana_cost: '{R}' }), // red → off-identity
      line({ name: 'Swords to Plowshares', mana_cost: '{W}' }), // in identity
      line({ name: 'Forest', type_line: 'Basic Land — Forest' }), // colourless cost
    ],
    commander,
  )
  assert.equal(v.length, 1)
  assert.equal(v[0]!.name, 'Lightning Bolt')
  assert.deepEqual(v[0]!.colors, ['R'])
})

test('deckColorIdentityViolations is empty without a commander', () => {
  assert.equal(deckColorIdentityViolations([line({ mana_cost: '{R}' })], null).length, 0)
})

test('deckSingletonViolations flags non-basic duplicates only', () => {
  const v = deckSingletonViolations([
    line({ name: 'Sol Ring', type_line: 'Artifact' }, 2), // violation
    line({ name: 'Mountain', type_line: 'Basic Land — Mountain' }, 30), // ok (basic)
    line({ name: 'Krenko', type_line: 'Legendary Creature' }, 1), // ok (single)
  ])
  assert.equal(v.length, 1)
  assert.equal(v[0]!.name, 'Sol Ring')
})

test('deckCardCount sums quantities', () => {
  assert.equal(deckCardCount([line({ id: 'a' }, 1), line({ id: 'b' }, 99)]), 100)
  assert.equal(deckCardCount([]), 0)
})

test('commanderDeckLegality: a 100-card, singleton, in-identity deck is legal', () => {
  const commander = card({ name: 'Atraxa', mana_cost: '{G}{W}{U}{B}', type_line: 'Legendary Creature' })
  const lines = [
    line({ name: 'Atraxa', mana_cost: '{G}{W}{U}{B}', type_line: 'Legendary Creature' }, 1),
    line({ name: 'Forest', type_line: 'Basic Land — Forest', oracle_text: '{T}: Add {G}.' }, 99), // basics may repeat
  ]
  const v = commanderDeckLegality(lines, commander)
  assert.equal(v.cardCount, 100)
  assert.equal(v.legal, true)
  assert.deepEqual(v.issues, [])
})

test('commanderDeckLegality: wrong count is illegal', () => {
  const commander = card({ mana_cost: '{R}' })
  const v = commanderDeckLegality([line({ name: 'Commander', mana_cost: '{R}' }, 1)], commander)
  assert.equal(v.legal, false)
  assert.equal(v.cardCount, 1)
  assert.equal(v.issues.length, 1)
  assert.match(v.issues[0]!, /exactly 100/)
})

test('commanderDeckLegality: no commander is illegal', () => {
  const v = commanderDeckLegality([line({ mana_cost: '{R}' }, 100)], null)
  assert.equal(v.legal, false)
  assert.match(v.issues[0]!, /No commander/)
})

test('commanderDeckLegality: reports count + singleton + colour-identity together', () => {
  const commander = card({ name: 'Krenko', mana_cost: '{2}{R}' }) // mono-red
  const lines = [
    line({ name: 'Krenko', mana_cost: '{2}{R}' }, 1),
    line({ name: 'Sol Ring', type_line: 'Artifact' }, 2), // singleton violation
    line({ name: 'Counterspell', mana_cost: '{U}{U}' }, 1), // off-identity (blue)
  ]
  const v = commanderDeckLegality(lines, commander)
  assert.equal(v.legal, false)
  assert.equal(v.cardCount, 4)
  assert.equal(v.issues.length, 3) // count, singleton, colour identity
  assert.ok(v.issues.some((i) => /exactly 100/.test(i)))
  assert.ok(v.issues.some((i) => /singleton/.test(i)))
  assert.ok(v.issues.some((i) => /colour identity/.test(i)))
})
