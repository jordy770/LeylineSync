// mig 266 — Equipment phase 1: the 'equip' activated effect moves
// attached_to and the equipped-scope continuous effects follow the host.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// EQ1 — Warhammer equips: host gains +3/+0 and trample; re-equip moves it.
test('EQ1 equip grants and re-equip moves the bonus', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const hammer = await s.spawn('A', 'Loxodon Warhammer Test', 'battlefield')
    const first = await s.spawnCreature('A', 'Dino Grunt Test') // 3/3
    const second = await s.spawnCreature('A', 'Air Elemental Test') // 4/4

    await s.setMana('A', { C: 3 })
    await s.as('A').activate(hammer, 0, { targetCardId: first })
    assert.equal(await s.effectivePower(first), 6) // 3 + 3

    await s.setMana('A', { C: 3 })
    await s.as('A').activate(hammer, 0, { targetCardId: second })
    assert.equal(await s.effectivePower(second), 7) // 4 + 3
    assert.equal(await s.effectivePower(first), 3) // bonus moved away
  })
})
