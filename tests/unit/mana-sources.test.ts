// manaSourceColors — what a permanent can tap for (lib/game/mana-sources).
// Focus: the custom-basic fallback (bug-2699): a scriptless "Basic Land" with an
// unknown subtype must still be a mana source, or bots (and tap hints) treat a
// whole custom manabase as dead and never cast anything.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { manaSourceColors } from '../../lib/game/mana-sources'

test('a real basic maps to its colour without any script', () => {
  assert.deepEqual(manaSourceColors(null, 'Basic Land — Forest'), { colors: ['G'], any: false, amount: 1 })
})

test('a custom basic with an unknown subtype and no script taps for any colour', () => {
  // bug-2699: "Barry's Land" (Basic Land — Cloud, script {}) — homebrew basics
  // without a script default to an any-colour source.
  assert.deepEqual(manaSourceColors({}, "Basic Land — Cloud"), { colors: [], any: true, amount: 1 })
  assert.deepEqual(manaSourceColors(null, 'Basic Land'), { colors: [], any: true, amount: 1 })
})

test('a scriptless nonbasic land is still not a mana source', () => {
  // Nonbasics keep needing a script — a utility land must not silently make mana.
  assert.equal(manaSourceColors(null, 'Land'), null)
  assert.equal(manaSourceColors({}, 'Land — Gate'), null)
})

test('a scripted mana ability wins over the basic fallback', () => {
  const script = {
    activated_abilities: [
      { is_mana_ability: true, costs: [{ type: 'tap_self' }], effects: [{ type: 'add_mana', color: 'U', amount: 2 }] },
    ],
  }
  const info = manaSourceColors(script as never, 'Basic Land — Cloud')
  assert.deepEqual(info, { colors: ['U'], any: false, amount: 2 })
})

test('a non-land with an empty script makes no mana', () => {
  assert.equal(manaSourceColors({}, 'Creature — Human'), null)
})
