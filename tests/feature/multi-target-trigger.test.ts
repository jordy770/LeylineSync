// Phase 3, slice 4b — multi-target triggered abilities (mig 116). "When this
// enters, destroy up to two target creatures an opponent controls." Exercises the
// announcement-time multi-pick (choose_triggered_ability_targets → target_card_ids)
// and the per-target apply loop in apply_trigger_effects.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// MTT1 — pick two targets: both are destroyed.
test('MTT1 multi-target ETB destroys both chosen creatures', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const a = await s.spawnCreature('B', 'Air Elemental Test')
    const b = await s.spawnCreature('B', 'Deathtouch Viper Test')
    await s.spawnCreature('A', 'Twin Slayer Test') // ETB: destroy up to two opp creatures

    const trigger = await s.topStackItem()
    assert.equal(trigger?.action_type, 'triggered_ability')
    assert.equal(trigger?.payload?.target_count, 2)

    await s.as('A').chooseTriggerTargets(trigger!.id, [a, b])
    await s.resolveStack()

    assert.equal(await s.zoneOf(a), 'graveyard')
    assert.equal(await s.zoneOf(b), 'graveyard')
  })
})

// MTT2 — "up to" — picking a single target is legal; only it is destroyed.
test('MTT2 multi-target ETB allows fewer than the max', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const a = await s.spawnCreature('B', 'Air Elemental Test')
    const b = await s.spawnCreature('B', 'Deathtouch Viper Test')
    await s.spawnCreature('A', 'Twin Slayer Test')

    const trigger = await s.topStackItem()
    await s.as('A').chooseTriggerTargets(trigger!.id, [a])
    await s.resolveStack()

    assert.equal(await s.zoneOf(a), 'graveyard')
    assert.equal(await s.zoneOf(b), 'battlefield') // untouched
  })
})

// MTT3 — more than target_count is rejected.
test('MTT3 multi-target ETB rejects choosing more than the max', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const a = await s.spawnCreature('B', 'Air Elemental Test')
    const b = await s.spawnCreature('B', 'Deathtouch Viper Test')
    const c = await s.spawnCreature('B', 'Air Elemental Test')
    await s.spawnCreature('A', 'Twin Slayer Test')

    const trigger = await s.topStackItem()
    await assert.rejects(() => s.as('A').chooseTriggerTargets(trigger!.id, [a, b, c]), /between 1 and 2/)
  })
})

// MTT4 — the controller restriction is enforced per target (your own creature is
// not a legal "an opponent controls" target).
test('MTT4 multi-target ETB enforces the controller restriction', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const opp = await s.spawnCreature('B', 'Air Elemental Test')
    const mine = await s.spawnCreature('A', 'Deathtouch Viper Test') // illegal target
    await s.spawnCreature('A', 'Twin Slayer Test')

    const trigger = await s.topStackItem()
    await assert.rejects(() => s.as('A').chooseTriggerTargets(trigger!.id, [opp, mine]), /legal target/)
  })
})
