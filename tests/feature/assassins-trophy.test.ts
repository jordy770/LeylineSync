// Assassin's Trophy (mig 152) — "Destroy target permanent an opponent controls. Its
// controller may search their library for a basic land card, put it onto the
// battlefield, then shuffle." The destroy is the permanent_effect; the rider parks a
// search_library DECISION for the destroyed permanent's controller (the opponent).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// ATR1 — destroy B's permanent; B is offered a basic-land search and takes it.
test('ATR1 the destroyed permanent\'s controller searches a basic land', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const target = await s.spawnCreature('B', 'Air Elemental Test')
    const basic = await s.spawn('B', 'Wastes Test', 'library') // a basic land

    await s.as('A').putOnStack('permanent_effect', {
      kind: 'destroy',
      target_card_id: target,
      target_type: 'permanent',
      target_controller: 'opponent',
      controller_searches_basic_land: true,
    })
    await s.resolveStack()

    assert.equal(await s.zoneOf(target), 'graveyard') // destroyed
    const decision = await s.pendingDecision()
    assert.equal(decision?.decision_type, 'search_library')
    assert.equal(decision?.deciding_player_id, s.playerId('B')) // B decides, not A

    await s.as('B').submitDecision(decision!.id, { chosen: [basic] })
    assert.equal(await s.zoneOf(basic), 'battlefield') // basic entered B's battlefield
  })
})

// ATR2 — the search is a "may": B can decline (the land stays in the library).
test('ATR2 the basic-land search is optional', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const target = await s.spawnCreature('B', 'Air Elemental Test')
    const basic = await s.spawn('B', 'Wastes Test', 'library')

    await s.as('A').putOnStack('permanent_effect', {
      kind: 'destroy',
      target_card_id: target,
      target_type: 'permanent',
      target_controller: 'opponent',
      controller_searches_basic_land: true,
    })
    await s.resolveStack()

    const decision = await s.pendingDecision()
    await s.as('B').submitDecision(decision!.id, { chosen: [] }) // decline

    assert.equal(await s.zoneOf(basic), 'library') // stays
  })
})
