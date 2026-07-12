// Adventure dual type_lines ("Creature — X // Instant — Adventure") must not
// let the BACK half drive the front face's cast timing (bug-1508, the client
// twin of the server-side bug-1019/mig 373). The creature half casts at
// sorcery speed; only the adventure half is the instant.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { canCardRespond, getCanQuickCast } from '../../lib/game/controller-selectors'
import { canCastHandSpell } from '../../components/controller/shared'
import type { ControllerCard } from '../../lib/game/types'

const rider = {
  id: 'gc1',
  zone: 'hand',
  name: 'Murderous Rider',
  cards: {
    type_line: 'Creature — Zombie Knight // Instant — Adventure',
    mana_cost: '{1}{B}{B}',
    // The REAL oracle text matters: 'target' + an instant back half classified
    // the whole card as a counterspell (bug-1512) — a fixture without
    // oracle_text green-lit the earlier broken build.
    oracle_text:
      'Lifelink\nSwift End {1}{B}{B} — Instant — Adventure\nDestroy target creature or planeswalker. You lose 2 life.',
    script: {
      schema_version: 2,
      adventure: {
        cost: '{1}{B}{B}',
        name: 'Swift End',
        spell_effect: {
          actions: [
            { type: 'destroy', target_type: ['creature', 'planeswalker'] },
            { type: 'lose_life', amount: 2, recipient: 'controller' },
          ],
        },
      },
    },
  },
} as unknown as ControllerCard

test('adventure creature face casts at sorcery speed, not instant', () => {
  assert.equal(getCanQuickCast(rider, true, true, 0), true, 'castable in your main phase')
  assert.equal(getCanQuickCast(rider, false, true, 0), false, 'NOT castable at instant speed')
  assert.equal(canCastHandSpell(rider, true, true, 0), true)
  assert.equal(canCastHandSpell(rider, false, true, 0), false)
})

test('adventure creature is not counted as an instant response', () => {
  assert.equal(canCardRespond(rider, false), false)
})

test('adventure halves are castable on an EMPTY stack (not counterspells)', () => {
  // bug-1512: doesCardRequireStackTarget saw instant+target in the full card
  // and stack-gated BOTH faces. Creature: sorcery-speed on empty stack.
  assert.equal(getCanQuickCast(rider, true, true, 0), true)
  // Adventure half (type forced to Instant, destroy program): instant-speed
  // on an empty stack via the permanent_effect bypass.
  const swiftEnd = {
    ...rider,
    copied_script: {
      schema_version: 2,
      spell_effect: (rider.cards as unknown as { script: { adventure: { spell_effect: unknown } } }).script.adventure.spell_effect,
    },
    cards: { ...(rider as { cards: object }).cards, type_line: 'Instant' },
  } as unknown as ControllerCard
  assert.equal(canCastHandSpell(swiftEnd, false, true, 0), true, 'Swift End castable with priority, empty stack')
  assert.equal(canCastHandSpell(swiftEnd, false, false, 0), false, 'but not without priority')
})

test('a plain instant still casts at instant speed', () => {
  const bolt = {
    id: 'gc2',
    zone: 'hand',
    name: 'Sample Instant',
    cards: { type_line: 'Instant', mana_cost: '{R}', script: { schema_version: 2 } },
  } as unknown as ControllerCard
  assert.equal(getCanQuickCast(bolt, false, true, 0), true)
})
