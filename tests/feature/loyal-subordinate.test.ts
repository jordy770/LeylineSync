// Loyal Subordinate (mig 205) — "Menace. Lieutenant — At the beginning of combat
// on your turn, if you control your commander, each opponent loses 3 life."
// fire_turn_step_triggers now fires beginning_of_combat (active player's
// permanents only = "on your turn"); the Lieutenant check is a `conditional`
// with the new commanders_you_control count source.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// LS1 — commander on the battlefield: each opponent loses 3 at combat.
test('LS1 with your commander out, combat drains each opponent', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCommander('A', 'Reaper Commander Test', 'battlefield')
    await s.spawnCreature('A', 'Loyal Subordinate Test')
    const before = await s.lifeOf('B')

    const st = await s.as('A').advanceStep()
    assert.equal(st.step, 'beginning_of_combat')
    const item = await s.topStackItem()
    assert.equal(item?.action_type, 'triggered_ability')
    await s.as('A').resolveStack()

    assert.equal(await s.lifeOf('B'), before - 3)
    assert.equal(await s.lifeOf('A'), 20) // the controller is unaffected
  })
})

// LS2 — commander still in the command zone: the trigger fires but the
// Lieutenant condition fails; nobody loses life.
test('LS2 without your commander on the battlefield, nothing happens', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCommander('A', 'Reaper Commander Test', 'command')
    await s.spawnCreature('A', 'Loyal Subordinate Test')
    const before = await s.lifeOf('B')

    await s.as('A').advanceStep()
    await s.as('A').resolveStack() // the trigger resolves; the conditional gates it off

    assert.equal(await s.lifeOf('B'), before)
  })
})

// LS3 — "on your turn": the trigger does not fire on an opponent's combat.
test('LS3 does not trigger on an opponent turn', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'B', priority: 'B' })
    await s.spawnCommander('A', 'Reaper Commander Test', 'battlefield')
    await s.spawnCreature('A', 'Loyal Subordinate Test')

    const st = await s.as('B').advanceStep()
    assert.equal(st.step, 'beginning_of_combat')
    assert.equal(await s.topStackItem(), null) // nothing enqueued
  })
})
