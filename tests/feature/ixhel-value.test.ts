// mig 273 — becomes_blocked event: Ichorclaw Myr pumps when blocked.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// IV1 — declaring a blocker fires becomes_blocked; the Myr measures 3/3.
test('IV1 Ichorclaw Myr pumps when blocked', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const myr = await s.spawnCreature('A', 'Ichorclaw Myr Test') // 1/1
    const wall = await s.spawnCreature('B', 'Dino Grunt Test')
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(myr, 'B')
    await s.setTurn({ phase: 'combat', step: 'declare_blockers', active: 'A', priority: 'B' })
    await s.as('B').declareBlocker(wall, myr)
    await s.as('A').resolveStack() // the becomes_blocked trigger

    assert.equal(await s.effectivePower(myr), 3) // 1 + 2
    assert.equal(await s.effectiveToughness(myr), 3)
  })
})
