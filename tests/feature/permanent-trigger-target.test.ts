// Phase 3, slice 3 — non-creature permanent targets for TRIGGERED abilities
// (mig 114). "When this enters, destroy target artifact." Exercises the full
// announcement-time trigger-target path generalised from creature to permanent:
// enqueue (target_required + real target_type) → choose_triggered_ability_creature_
// target (permanent validation) → apply_targeted_triggered_ability_effects →
// apply_creature_effect (works on any permanent).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// PTT1 — ETB "destroy target artifact" hits the chosen artifact.
test('PTT1 permanent-target ETB destroys the chosen artifact', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const art = await s.spawn('B', 'Green Mana Vessel Test', 'battlefield') // an artifact
    await s.spawnCreature('A', 'Artifact Smasher Test') // ETB: destroy target artifact

    const trigger = await s.topStackItem()
    assert.equal(trigger?.action_type, 'triggered_ability')
    assert.equal(trigger?.payload?.target_required, true)

    await s.as('A').chooseTriggerTarget(trigger!.id, art)
    await s.resolveStack()

    assert.equal(await s.zoneOf(art), 'graveyard')
  })
})

// PTT2 — the target must match the type: a creature is not a legal "artifact" target.
test('PTT2 permanent-target ETB rejects a target of the wrong type', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('B', 'Green Mana Vessel Test', 'battlefield') // a legal artifact exists
    const creature = await s.spawnCreature('B', 'Air Elemental Test') // not an artifact
    await s.spawnCreature('A', 'Artifact Smasher Test')

    const trigger = await s.topStackItem()
    assert.equal(trigger?.action_type, 'triggered_ability')

    await assert.rejects(() => s.as('A').chooseTriggerTarget(trigger!.id, creature), /legal permanent/)
  })
})

// PTT3 — no legal artifact target → the ability is not enqueued (no softlock).
test('PTT3 permanent-target ETB with no legal target does not enqueue', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    // No artifacts anywhere; only a creature on the board.
    await s.spawnCreature('B', 'Air Elemental Test')
    const smasher = await s.spawnCreature('A', 'Artifact Smasher Test')

    const trigger = await s.topStackItem()
    // The trigger finds no legal target → it is not put on the stack.
    assert.notEqual(trigger?.action_type, 'triggered_ability')
    assert.equal(await s.zoneOf(smasher), 'battlefield')
  })
})

// PTT4 — the existing creature-target trigger path is unchanged (regression guard
// for the generalised enqueue/picker/apply).
test('PTT4 creature-target ETB still works after the generalisation', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const victim = await s.spawnCreature('B', 'Air Elemental Test')
    await s.spawnCreature('A', 'Ravenous Chupacabra Test') // ETB destroy opp creature

    const trigger = await s.topStackItem()
    assert.equal(trigger?.payload?.target_required, true)
    await s.as('A').chooseTriggerTarget(trigger!.id, victim)
    await s.resolveStack()

    assert.equal(await s.zoneOf(victim), 'graveyard')
  })
})
