// Laboratory Drudge (mig 206) — "At the beginning of each end step, draw a card
// if you've cast a spell from a graveyard or activated an ability of a card in a
// graveyard this turn." Pieces: the turn-stamped graveyard-cast tracker (bumped
// by flashback casts and cast-from-graveyard permission casts), the
// graveyard_casts_this_turn count source, and the beginning_of_each_end_step
// event (fires on EVERY player's end step, not just the controller's).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// Flashback "Snap Recall" (instant, {U} flashback, draw 1) from A's graveyard.
async function flashbackRecall(s: Scenario): Promise<void> {
  const recall = await s.spawn('A', 'Snap Recall Test', 'graveyard')
  await s.spawn('A', 'Air Elemental Test', 'library') // the card it draws
  await s.setMana('A', { U: 1 })
  await s.as('A').castSpellEffect([{ type: 'draw', amount: 1 }], recall)
  await s.as('A').resolveStack()
}

// LD1 — flashback a spell, reach the end step: the Drudge draws.
test('LD1 a flashback cast this turn draws at end step', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Laboratory Drudge Test')
    await s.spawn('A', 'Air Elemental Test', 'library') // the end-step draw

    await flashbackRecall(s)

    const handBefore = await s.zoneCount('A', 'hand')
    await s.setTurn({ phase: 'ending', step: 'end', active: 'A', priority: 'A' })
    await s.as('A').resolveStack() // the Drudge trigger resolves

    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 1) // condition held → draw
  })
})

// LD2 — no graveyard cast this turn: the trigger resolves as a no-op.
test('LD2 without a graveyard cast, no draw', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Laboratory Drudge Test')
    await s.spawn('A', 'Air Elemental Test', 'library')

    const handBefore = await s.zoneCount('A', 'hand')
    await s.setTurn({ phase: 'ending', step: 'end', active: 'A', priority: 'A' })
    await s.as('A').resolveStack()

    assert.equal(await s.zoneCount('A', 'hand'), handBefore) // gated off
  })
})

// LD3 — "EACH end step": A flashbacks an INSTANT on B's turn, and A's Drudge
// triggers on B's end step.
test('LD3 triggers on an opponent end step too', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'B', priority: 'A' })
    await s.spawnCreature('A', 'Laboratory Drudge Test')
    await s.spawn('A', 'Air Elemental Test', 'library')

    await flashbackRecall(s) // instant-speed, on B's turn

    const handBefore = await s.zoneCount('A', 'hand')
    await s.setTurn({ phase: 'ending', step: 'end', active: 'B', priority: 'B' })
    await s.as('A').resolveStack() // A's Drudge triggered on B's end step

    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 1)
  })
})
