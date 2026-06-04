// Feature group 080/081 — targeted ETB triggers, controller (ownership)
// restriction, no-softlock fizzle, and the bug-098 auto-resolve fix.
// See docs/test-plan-079-086.md (Group 3).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// TT1 — Ravenous Chupacabra ETB destroys a chosen opponent creature.
// Exercises the full targeted-trigger path: ETB enqueue -> choose target ->
// apply_targeted_triggered_ability_effects -> apply_creature_effect -> put_in_graveyard.
test('TT1 targeted ETB destroy hits the chosen opponent creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const victim = await s.spawnCreature('B', 'Air Elemental Test') // vanilla, no ETB
    await s.spawnCreature('A', 'Ravenous Chupacabra Test') // ETB: destroy opp creature

    const trigger = await s.topStackItem()
    assert.equal(trigger?.action_type, 'triggered_ability')

    await s.as('A').chooseTriggerTarget(trigger!.id, victim)
    await s.resolveStack()

    assert.equal(await s.zoneOf(victim), 'graveyard')
  })
})

// TT2 — ownership enforced: cannot target your OWN creature with an
// "an opponent controls" trigger.
test('TT2 targeted ETB rejects targeting your own creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    await s.spawnCreature('B', 'Air Elemental Test') // legal target exists
    const ownCreature = await s.spawnCreature('A', 'Deathtouch Viper Test') // illegal target
    await s.spawnCreature('A', 'Ravenous Chupacabra Test')

    const trigger = await s.topStackItem()
    assert.equal(trigger?.action_type, 'triggered_ability')

    await assert.rejects(() => s.as('A').chooseTriggerTarget(trigger!.id, ownCreature))
  })
})

// TT3 — no-softlock: ETB with no legal opponent target fizzles harmlessly.
test('TT3 targeted ETB fizzles with no legal target (no softlock)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const chupacabra = await s.spawnCreature('A', 'Ravenous Chupacabra Test') // B has no creatures

    // If a trigger is on the stack, resolving it must NOT raise (it fizzles);
    // if no target-required trigger was enqueued, the stack is empty.
    const trigger = await s.topStackItem()
    if (trigger?.action_type === 'triggered_ability') {
      await s.resolveStack() // must not throw
    }
    assert.equal(await s.zoneOf(chupacabra), 'battlefield')
  })
})

// bug-098 — recipient-based (non-creature-target) trigger effects auto-resolve
// to each opponent / controller; they are NOT dropped and do NOT prompt for a
// creature target. Welcome Drain ETB: each opponent loses 2, you gain 2.
test('bug-098 recipient-based ETB auto-resolves (no target prompt)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const aBefore = await s.lifeOf('A')
    const bBefore = await s.lifeOf('B')

    await s.spawnCreature('A', 'Welcome Drain Test')
    const trigger = await s.topStackItem()
    assert.equal(trigger?.action_type, 'triggered_ability')
    // Not target-required — resolves straight away with no chooseTriggerTarget.
    await s.resolveStack()

    assert.equal(await s.lifeOf('B'), bBefore - 2)
    assert.equal(await s.lifeOf('A'), aBefore + 2)
  })
})
