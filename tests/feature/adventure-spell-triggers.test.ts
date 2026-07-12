// Adventure casts and spell-cast watchers (mig 388, bug-1513). A spell on the
// stack has ONLY its cast face's characteristics: the adventure half is a
// noncreature spell with the ADVENTURE's mana value (Y'shtola must fire on
// Swift End), while the creature half stays a creature spell (Y'shtola must
// NOT fire). Fourth member of the dual-type-line bug family (1019/1508/1512).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

const SWIFT_REMOVAL_ACTIONS = [{ type: 'draw', amount: 1, recipient: 'controller' }]

test('AST1 the adventure half fires noncreature spell watchers', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawn('A', 'Spellcraft Watcher Test', 'battlefield')
    const adventurer = await s.spawn('A', 'Removal Adventurer Test', 'hand')

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { B: 2, C: 1 })
    const aBefore = await s.lifeOf('A')
    const bBefore = await s.lifeOf('B')

    await s.as('A').castSpellEffect(SWIFT_REMOVAL_ACTIONS, adventurer, null, null, true)
    await s.as('A').resolveStack()

    assert.equal(await s.lifeOf('B'), bBefore - 2, 'opponent lost 2 (watcher fired on the MV-3 instant)')
    assert.equal(await s.lifeOf('A'), aBefore + 2, 'caster gained 2')
  })
})

test('AST2 the creature half does NOT fire noncreature watchers', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawn('A', 'Spellcraft Watcher Test', 'battlefield')
    const adventurer = await s.spawn('A', 'Removal Adventurer Test', 'hand')

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { B: 2, C: 1 })
    const aBefore = await s.lifeOf('A')
    const bBefore = await s.lifeOf('B')

    await s.as('A').castPermanent(adventurer)
    await s.as('A').resolveStack()

    assert.equal((await s.cardState(adventurer)).zone, 'battlefield')
    assert.equal(await s.lifeOf('B'), bBefore, 'no trigger from a creature cast')
    assert.equal(await s.lifeOf('A'), aBefore, 'no lifegain either')
  })
})

test('AST3 the MV filter reads the ADVENTURE cost, not the printed one', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawn('A', 'Spellcraft Watcher Test', 'battlefield')
    // Printed {4}{B} (MV 5) but the adventure is {1} (MV 1) — below the
    // watcher's min_mana_value 3, so casting it must NOT fire.
    const cheap = await s.spawn('A', 'Cheap Adventurer Test', 'hand')

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { C: 1 })
    const bBefore = await s.lifeOf('B')

    await s.as('A').castSpellEffect(SWIFT_REMOVAL_ACTIONS, cheap, null, null, true)
    await s.as('A').resolveStack()

    assert.equal(await s.lifeOf('B'), bBefore, 'MV 1 adventure stays under the MV-3 filter')
  })
})
