// Phase 4 / F1b — a new stack object restarts the priority round (mig 124). Until
// now a respond-then-pass could short-circuit the round: pass_priority counts
// consecutive passes, but a cast in response didn't reset the count, so the
// responder could pass and resolve their own spell before opponents responded.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'

// PR1 — A casts, A passes (B gets priority), B RESPONDS with a spell. That reset
// must restart the round: after B passes, priority returns to A and nothing has
// resolved yet (without the fix B's pass would have resolved B's spell).
test('PR1 a response restarts the priority round', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    await s.as('A').putOnStack('draw_cards', { amount: 1 }) // A casts
    await s.as('A').passPriority() // priority -> B, count 1
    await s.as('B').putOnStack('draw_cards', { amount: 1 }) // B responds -> count reset to 0
    await s.as('B').passPriority() // priority -> A, count 1 (must NOT resolve)

    const ts = await s.priorityState()
    assert.equal(ts.priority_player_id, s.playerId('A')) // A gets to respond
    assert.equal(await s.pendingCount(), 2) // nothing resolved yet
  })
})

// PR2 — the round still completes normally: with no response, both players passing
// in a row resolves the top of the stack.
test('PR2 the stack resolves once all players pass in a row', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Air Elemental Test', 'library') // something to draw

    await s.as('A').putOnStack('draw_cards', { amount: 1 })
    await s.as('A').passPriority() // priority -> B, count 1
    await s.as('B').passPriority() // count 2 == players -> resolves the draw

    assert.equal(await s.pendingCount(), 0)
  })
})
