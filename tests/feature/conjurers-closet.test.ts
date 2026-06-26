// Conjurer's Closet (mig 351). "At the beginning of your end step, you may exile
// target creature you control, then return that card to the battlefield under your
// control." New blink effect (exile + return, re-firing ETB), an optional targeted
// end_step trigger.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// CC1 — blinking an ETB creature re-fires its enter trigger.
test('CC1 blink re-fires the creature\'s ETB', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Closet Test', 'battlefield')
    const pinger = await s.spawnCreature('A', 'ETB Ping Test') // ETB: each opponent loses 1
    while (await s.topStackItem()) await s.as('A').resolveStack() // flush the initial ETB
    const lifeB = await s.lifeOf('B')

    // Trigger the end step; the Closet's blink targets the pinger.
    await s.setTurn({ phase: 'ending', step: 'end', active: 'A', priority: 'A' })
    const trig = await s.topStackItem() // the Closet's blink trigger, awaiting a target
    assert.equal(trig?.action_type, 'triggered_ability')
    await s.as('A').chooseTriggerTarget(trig!.id, pinger)
    while (await s.topStackItem()) await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(pinger), 'battlefield', 'creature returned to the battlefield')
    assert.equal(await s.lifeOf('B'), lifeB - 1, 'ETB re-fired on the blink')
  })
})
