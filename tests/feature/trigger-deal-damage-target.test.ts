// Targeted deal_damage from a TRIGGERED ability (Flame Mage: "When this enters,
// deal 2 damage to target creature an opponent controls."). The engine already
// routes deal_damage through the targeted-trigger path (trigger_effect_target_type
// lists it); this guards that path AND backs the registry change that makes such a
// trigger form-authorable (deal_damage_target gained the 'trigger' context).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// FM1 — ETB "deal 2 damage to target creature an opponent controls" marks the target.
test('FM1 targeted-damage ETB deals 2 to the chosen creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const victim = await s.spawnCreature('B', 'Air Elemental Test') // a 4/4 — survives, takes 2
    await s.spawnCreature('A', 'Flame Mage Test')

    const trigger = await s.topStackItem()
    assert.equal(trigger?.action_type, 'triggered_ability')
    assert.equal(trigger?.payload?.target_required, true)

    await s.as('A').chooseTriggerTarget(trigger!.id, victim)
    await s.resolveStack()

    assert.equal((await s.cardState(victim)).damage_marked, 2)
  })
})

// FM2 — the target must be a creature an opponent controls (your own is illegal).
test('FM2 the targeted-damage ETB rejects a creature you control', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const own = await s.spawnCreature('A', 'Air Elemental Test') // yours
    await s.spawnCreature('B', 'Grave Shambler Test') // a legal opponent target exists
    await s.spawnCreature('A', 'Flame Mage Test')

    const trigger = await s.topStackItem()
    await assert.rejects(() => s.as('A').chooseTriggerTarget(trigger!.id, own))
  })
})
