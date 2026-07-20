import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => { await ensureTestCards() })

test('CX1 casting a cascade permanent enqueues a cascade trigger', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bear = await s.spawn('A', 'Cascade Bear Test', 'library') // MV 2 < 5 window
    const wurm = await s.spawn('A', 'Cascade Wurm Test', 'hand')    // {4}{G} = MV 5
    await s.setMana('A', { G: 1, C: 4 })
    await s.as('A').castPermanent(wurm)

    const stack = await s.pendingStack()
    const cascade = stack.find((i) => i.action_type === 'triggered_ability'
      && Array.isArray((i.payload.effects as unknown[]))
      && JSON.stringify(i.payload.effects).includes('"cascade"'))
    assert.ok(cascade, 'a cascade trigger is on the stack above the wurm')
  })
})
