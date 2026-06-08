// Sacrifice-self as an activated-ability cost (mig 175). Commander's Sphere's
// "Sacrifice Commander's Sphere: Draw a card" pays the cost by moving the source
// to the graveyard, then the draw resolves off the stack. Before mig 175,
// activate_ability raised 'Unsupported ability cost: sacrifice_self'.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// SAC1 — activating the sac ability sacrifices the source and draws a card.
test('SAC1 sacrifice-self cost moves the source to graveyard and draws', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const sphere = await s.spawn('A', "Commander's Sphere Test", 'battlefield')
    await s.spawn('A', 'Air Elemental Test', 'library')
    const handBefore = await s.zoneCount('A', 'hand')

    await s.as('A').activate(sphere, 0) // index 0 = "Sacrifice: Draw a card"
    // Source is sacrificed immediately as a cost, before the draw resolves.
    assert.equal(await s.zoneOf(sphere), 'graveyard')

    await s.as('A').resolveStack()
    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 1)
  })
})

// SAC2 — the sacrifice is a cost, so it happens even though no mana/tap is paid;
// the Sphere cannot be activated a second time (already in the graveyard).
test('SAC2 a sacrificed source cannot be activated again', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const sphere = await s.spawn('A', "Commander's Sphere Test", 'battlefield')
    await s.spawn('A', 'Air Elemental Test', 'library')

    await s.as('A').activate(sphere, 0)
    await s.as('A').resolveStack()

    // Second activation: source is no longer on the battlefield.
    await assert.rejects(() => s.as('A').activate(sphere, 0), /must be on the battlefield/i)
  })
})
