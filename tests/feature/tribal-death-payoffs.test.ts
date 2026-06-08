// Tribal death payoffs (Undead Unleashed) — confirm the watcher system handles
// the precon's "Whenever [another] Zombie you control dies, …" cards end-to-end:
// Vengeful Dead (drains even on its OWN death — no exclude_self) and Diregraf
// Captain (typed lord + an exclude_self death-drain).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// VD1 — Vengeful Dead drains when another Zombie dies AND when it dies itself.
test('VD1 Vengeful Dead drains on any Zombie death, including its own', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const vd = await s.spawnCreature('A', 'Vengeful Dead Test')
    const other = await s.spawnCreature('A', 'Grave Shambler Test') // a Zombie you control

    let b = await s.lifeOf('B')
    await s.as('A').putOnStack('destroy_creature', { target_card_id: other, target_controller: 'any' })
    await s.as('A').resolveStack() // destroy → death broadcast
    await s.as('A').resolveStack() // drain resolves
    assert.equal(await s.lifeOf('B'), b - 1)

    b = await s.lifeOf('B')
    await s.as('A').putOnStack('destroy_creature', { target_card_id: vd, target_controller: 'any' })
    await s.as('A').resolveStack()
    await s.as('A').resolveStack()
    assert.equal(await s.lifeOf('B'), b - 1) // no exclude_self → fires on its own death
  })
})

// DC1 — Diregraf Captain buffs other Zombies and drains when one dies.
test('DC1 Diregraf Captain (lord + death-drain)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Diregraf Captain Test')
    const z = await s.spawnCreature('A', 'Grave Shambler Test') // 2/2 Zombie
    await s.as('A').rebuild()
    assert.equal(await s.effectivePower(z), 3) // lord +1/+1
    assert.equal(await s.effectiveToughness(z), 3)

    const b = await s.lifeOf('B')
    await s.as('A').putOnStack('destroy_creature', { target_card_id: z, target_controller: 'any' })
    await s.as('A').resolveStack()
    await s.as('A').resolveStack()
    assert.equal(await s.lifeOf('B'), b - 1)
  })
})
