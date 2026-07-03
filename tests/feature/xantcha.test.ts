// Xantcha, Sleeper Agent (mig 361). "Xantcha enters under the control of an
// opponent of your choice. {3}: Xantcha's controller loses 2 life and you draw a
// card." New donate_self effect hands the source to an opponent at ETB.
// APPROXIMATIONS: "of your choice" = first opponent; the forced-attack static and
// "any player may activate" are not modelled (the controller activates).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// XA1 — Xantcha enters under an opponent's control.
test('XA1 Xantcha is donated to an opponent on entry', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const xantcha = await s.spawnCreature('A', 'Xantcha Test') // A "casts" it
    await s.as('A').resolveStack() // the ETB donate resolves

    assert.equal((await s.cardState(xantcha)).controller_player_id, s.playerId('B'),
      'Xantcha entered under the opponent\'s control')
  })
})

// XA2 — the activated ability drains the controller and draws.
test('XA2 the {3} ability: controller loses 2 and draws', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const xantcha = await s.spawnCreature('A', 'Xantcha Test')
    await s.as('A').resolveStack() // donate → B controls it
    await s.spawn('B', 'Air Elemental Test', 'library') // a card for B to draw
    await s.setMana('B', { C: 3 })
    const lifeB = await s.lifeOf('B')
    const handB = await s.zoneCount('B', 'hand')

    // B (the controller) activates it.
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'B', priority: 'B' })
    await s.as('B').activate(xantcha, 0)
    await s.as('B').resolveStack()

    assert.equal(await s.lifeOf('B'), lifeB - 2, 'controller lost 2 life')
    assert.equal(await s.zoneCount('B', 'hand'), handB + 1, 'activator drew a card')
  })
})
