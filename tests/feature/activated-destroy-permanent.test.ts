// Activated destroy of a NON-creature permanent (mig 188). Unstable Obelisk:
// "{7}, {T}, Sacrifice Unstable Obelisk: Destroy target permanent." The activated
// removal branch routes a non-creature-only target through the type-flexible
// permanent_effect action instead of destroy_creature (which rejects non-creatures).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// UO1 — destroy a target ENCHANTMENT (a non-creature permanent); the source is
// sacrificed as a cost.
test('UO1 destroys a non-creature permanent and sacrifices the source', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const obelisk = await s.spawn('A', 'Unstable Obelisk Test', 'battlefield')
    const ench = await s.spawn('B', 'Exploration Test', 'battlefield') // an Enchantment
    await s.setMana('A', { C: 7 }) // {7}

    await s.as('A').activate(obelisk, 1, { targetCardId: ench })
    assert.equal(await s.zoneOf(obelisk), 'graveyard') // sacrificed as a cost

    await s.as('A').resolveStack()
    assert.equal(await s.zoneOf(ench), 'graveyard') // destroyed
  })
})

// UO2 — "target permanent" also covers creatures (the broadened path still handles
// the common case).
test('UO2 the permanent target also destroys a creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const obelisk = await s.spawn('A', 'Unstable Obelisk Test', 'battlefield')
    const creature = await s.spawnCreature('B', 'Grave Shambler Test')
    await s.setMana('A', { C: 7 })

    await s.as('A').activate(obelisk, 1, { targetCardId: creature })
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(creature), 'graveyard')
  })
})

// UO3 — the target must be a battlefield permanent (a card in a graveyard isn't).
test('UO3 a non-battlefield target is rejected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const obelisk = await s.spawn('A', 'Unstable Obelisk Test', 'battlefield')
    const inGrave = await s.spawn('B', 'Grave Shambler Test', 'graveyard')
    await s.setMana('A', { C: 7 })

    await client.query('savepoint sp_uo3')
    await assert.rejects(
      () => s.as('A').activate(obelisk, 1, { targetCardId: inGrave }),
      /not a legal permanent/,
    )
    await client.query('rollback to savepoint sp_uo3')

    assert.equal(await s.zoneOf(obelisk), 'battlefield') // not sacrificed
  })
})
