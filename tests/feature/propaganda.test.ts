// Propaganda / attack tax (existing attack_tax mechanism): creatures can't
// attack the enchantment's controller unless the attacker's controller pays {2}
// per attacker. Scripted as an affected:'controller' attack_tax continuous
// effect; declare_attacker charges payload.mana from the attacker's pool.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// PROP1 — with {2} available, the attack is legal and the tax is paid.
test('PROP1 attacker pays the {2} tax to attack the Propaganda player', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawn('A', 'Attack Tax Test', 'battlefield')
    const attacker = await s.spawnCreature('B', 'Air Elemental Test')

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'B', priority: 'B' })
    await s.setMana('B', { C: 2 })

    await s.as('B').declareAttacker(attacker, 'A')
    assert.equal((await s.manaOf('B')).C, 0) // {2} drained by the tax
  })
})

// PROP2 — without the mana, the declaration is rejected.
test('PROP2 attacker without the tax mana cannot attack', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawn('A', 'Attack Tax Test', 'battlefield')
    const attacker = await s.spawnCreature('B', 'Air Elemental Test')

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'B', priority: 'B' })
    await s.setMana('B', { C: 0 })

    await assert.rejects(() => s.as('B').declareAttacker(attacker, 'A'))
  })
})
