// you_gain_life triggered event (mig 336). Marauding Blight-Priest: "Whenever
// you gain life, each opponent loses 1 life." A player-scoped event fired by the
// new fire_lifegain_triggers helper, wired in after every life-gain site. These
// tests drive the gain_life action path (the single point of logic all 6 call
// sites share).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// LG1 — gaining 2 life with a "whenever you gain life" payoff out drains the
// opponent for 1 (once, regardless of the amount gained).
test('LG1 gaining life drains each opponent', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Blight Priest Test')
    const lifeA = await s.lifeOf('A')
    const lifeB = await s.lifeOf('B')

    await s.spawnCreature('A', 'Gain Two Test') // ETB: you gain 2 life
    await s.as('A').resolveStack() // gain_life resolves → fires you_gain_life
    await s.as('A').resolveStack() // Blight Priest's drain resolves

    assert.equal(await s.lifeOf('A'), lifeA + 2, 'controller gained 2')
    assert.equal(await s.lifeOf('B'), lifeB - 1, 'each opponent lost 1')
  })
})

// LG2 — "whenever YOU gain life" is scoped to the payoff's controller: A's Blight
// Priest fires only when A gains life. When B gains life, A's priest stays silent,
// so nobody is drained.
test('LG2 the payoff only fires for ITS controller gaining life', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Blight Priest Test') // belongs to A
    const lifeA = await s.lifeOf('A')
    const lifeB = await s.lifeOf('B')

    await s.spawnCreature('B', 'Gain Two Test') // B gains 2 — not A's life gain
    await s.as('A').resolveStack() // ETB gain resolves; no drain trigger is enqueued

    assert.equal(await s.lifeOf('B'), lifeB + 2, 'B gained 2')
    assert.equal(await s.lifeOf('A'), lifeA, "A's priest did not fire (A gained no life)")
  })
})
