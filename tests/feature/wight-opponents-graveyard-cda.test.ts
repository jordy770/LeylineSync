// mig 389 — CDA count 'creature_cards_in_opponents_graveyards' (Wight of
// Precinct Six, Wilhelt precon): power/toughness = plus + creature cards in
// every OTHER player's graveyard. Own graveyard and non-creature cards don't
// count.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

test('WG1 Wight grows with creature cards in opponents graveyards only', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const wight = await s.spawnCreature('A', 'Wight of Precinct Six Test')

    // Empty graveyards: printed 1/1 (cda plus:1 + count 0).
    assert.equal(await s.effectivePower(wight), 1)
    assert.equal(await s.effectiveToughness(wight), 1)

    // Two creature cards in B's graveyard → 3/3.
    await s.spawn('B', 'Air Elemental Test', 'graveyard')
    await s.spawn('B', 'Air Elemental Test', 'graveyard')
    assert.equal(await s.effectivePower(wight), 3)
    assert.equal(await s.effectiveToughness(wight), 3)

    // A creature card in the controller's OWN graveyard does not count.
    await s.spawn('A', 'Air Elemental Test', 'graveyard')
    assert.equal(await s.effectivePower(wight), 3)
  })
})
