// Draw-floor fix (mig 334). The draw branch of apply_triggered_ability_effects
// used 1..greatest(1, amount), so a dynamic/count draw that resolves to 0 still
// drew 1. Now: an absent `amount` defaults to 1 ("draw a card"); a present
// amount draws exactly that many, including 0.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// DF1 — the bug: "draw a card for each creature card in your graveyard" with an
// EMPTY graveyard draws ZERO, not 1.
test('DF1 count draw of 0 draws nothing', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Air Elemental Test', 'library') // a card is available to draw
    const handBefore = await s.zoneCount('A', 'hand')

    await s.spawnCreature('A', 'Floor Drummer Test') // empty graveyard → draw 0
    await s.as('A').resolveStack()

    assert.equal(await s.zoneCount('A', 'hand'), handBefore)
  })
})

// DF2 — the same effect with 2 creature cards in the graveyard draws 2 (the path
// still works for a non-zero count).
test('DF2 count draw of N draws N', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Grave Shambler Test', 'graveyard')
    await s.spawn('A', 'Grave Shambler Test', 'graveyard') // 2 creature cards in graveyard
    await s.spawn('A', 'Air Elemental Test', 'library')
    await s.spawn('A', 'Air Elemental Test', 'library')
    const handBefore = await s.zoneCount('A', 'hand')

    await s.spawnCreature('A', 'Floor Drummer Test')
    await s.as('A').resolveStack()

    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 2)
  })
})

// DF3 — regression guard: "draw a card" with NO amount key still draws exactly 1.
test('DF3 draw with no amount defaults to 1', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Air Elemental Test', 'library')
    const handBefore = await s.zoneCount('A', 'hand')

    await s.spawnCreature('A', 'Plain Drummer Test')
    await s.as('A').resolveStack()

    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 1)
  })
})
