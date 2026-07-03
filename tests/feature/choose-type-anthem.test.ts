// choose_creature_type → persistent anthem (mig 337). A "choose a creature type"
// permanent (Radiant Destiny: chosen type gets +1/+1) registers a continuous pump
// keyed on the chosen type. The fix: submit_decision now calls
// rebuild_scripted_continuous_effects after baking $chosen, so the anthem
// re-registers with the concrete type (pre-choice it carried "$chosen" → matched
// nothing).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// AN1 — choosing Vampire pumps your Vampires +1/+1 and leaves other types alone.
test('AN1 chosen-type anthem pumps only the chosen type', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const vamp = await s.spawnCreature('A', 'Vampire Bear Test') // 2/2 Vampire
    const zombie = await s.spawnCreature('A', 'Grave Shambler Test') // 2/2 Zombie

    await s.spawn('A', 'Radiant Destiny Test', 'battlefield') // ETB: choose a type
    await s.as('A').resolveStack() // parks the choose_creature_type decision
    const d = await s.pendingDecision()
    assert.equal(d?.decision_type, 'choose_creature_type')
    await s.as('A').submitDecision(d!.id, { type: 'Vampire' })

    assert.equal(await s.effectivePower(vamp), 3, 'Vampire pumped +1')
    assert.equal(await s.effectiveToughness(vamp), 3, 'Vampire pumped +1')
    assert.equal(await s.effectivePower(zombie), 2, 'non-Vampire unchanged')
    assert.equal(await s.effectiveToughness(zombie), 2, 'non-Vampire unchanged')
  })
})

// AN2 — choosing a different type moves the anthem: Zombie chosen pumps the
// Zombie, not the Vampire.
test('AN2 the anthem follows the chosen type', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const vamp = await s.spawnCreature('A', 'Vampire Bear Test')
    const zombie = await s.spawnCreature('A', 'Grave Shambler Test')

    await s.spawn('A', 'Radiant Destiny Test', 'battlefield')
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { type: 'Zombie' })

    assert.equal(await s.effectivePower(zombie), 3, 'Zombie pumped +1')
    assert.equal(await s.effectivePower(vamp), 2, 'Vampire unchanged')
  })
})

// AN3 — the anthem is your-controller scoped: an opponent's Vampire is not pumped.
test('AN3 the anthem only pumps the controller\'s creatures', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const mine = await s.spawnCreature('A', 'Vampire Bear Test')
    const theirs = await s.spawnCreature('B', 'Vampire Bear Test')

    await s.spawn('A', 'Radiant Destiny Test', 'battlefield')
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { type: 'Vampire' })

    assert.equal(await s.effectivePower(mine), 3, 'my Vampire pumped')
    assert.equal(await s.effectivePower(theirs), 2, "opponent's Vampire unchanged")
  })
})
