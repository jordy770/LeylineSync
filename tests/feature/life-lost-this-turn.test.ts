// Life-loss-this-turn tracker (mig 294): a BEFORE UPDATE trigger accumulates
// every life decrease into game_session_players.life_lost_this_turn, exposed via
// the resolve_count_amount token max_life_lost_this_turn. Gates Y'shtola's
// end-step draw ("if a player lost 4 or more life this turn, you draw a card")
// through a `conditional` effect.
//
// Life Loss Drawer Test: "At the beginning of each end step, if a player lost 4
// or more life this turn, you draw a card."

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// LL1 — the trigger accumulates a life decrease, and the gated draw fires at 4.
test('LL1 life loss of 4 accumulates and fires the end-step draw', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawnCreature('A', 'Life Loss Drawer Test')
    await s.spawn('A', 'Spellcraft Spark Test', 'library') // something to draw

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.adjustLife('B', -4)

    const handBefore = await s.zoneCount('A', 'hand')
    await s.setTurn({ phase: 'ending', step: 'end', active: 'A', priority: 'A' }) // fires each_end_step
    await s.as('A').resolveStack()

    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 1)
  })
})

// LL2 — below the threshold (3 < 4): the trigger fires but the draw is gated off
// (a card is in the library, so a miss here would be a real failure, not empty).
test('LL2 life loss of 3 does not fire the draw', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawnCreature('A', 'Life Loss Drawer Test')
    await s.spawn('A', 'Spellcraft Spark Test', 'library')

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.adjustLife('B', -3)

    const handBefore = await s.zoneCount('A', 'hand')
    await s.setTurn({ phase: 'ending', step: 'end', active: 'A', priority: 'A' })
    await s.as('A').resolveStack()

    assert.equal(await s.zoneCount('A', 'hand'), handBefore)
  })
})
