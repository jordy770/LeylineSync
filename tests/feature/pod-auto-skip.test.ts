// Server-side pod auto-skip (mig 309): when a player passes priority on an empty
// stack, pass_priority chains the passes for every downstream player whose
// persisted autopass_settings say they'd auto-pass here too — so a whole empty
// round collapses into one call instead of one client round-trip per opponent.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// PA1 — all three opponents auto-pass: the active player's single pass on an
// empty step chains through B/C/D and advances the step in one call.
test('PA1 active pass chains through auto-passing opponents and advances', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 4)
    await s.setAutoPass('B', { op: true })
    await s.setAutoPass('C', { op: true })
    await s.setAutoPass('D', { op: true })
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    await s.passPriority('A')

    const t = await s.turnStep()
    assert.equal(t.step, 'beginning_of_combat', 'whole round passed → step advanced')
    assert.equal(t.active_player_id, s.playerId('A'), 'still A’s turn')
  })
})

// PA2 — one opponent wants to act (op off): the chain skips B/C but stops at D,
// handing D priority without advancing.
test('PA2 chain stops at the first opponent who would not auto-pass', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 4)
    await s.setAutoPass('B', { op: true })
    await s.setAutoPass('C', { op: true })
    await s.setAutoPass('D', { op: false }) // D holds up — keep priority
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    await s.passPriority('A')

    const t = await s.turnStep()
    assert.equal(t.step, 'precombat_main', 'did not advance — D still has priority')
    const p = await s.priorityState()
    assert.equal(p.priority_player_id, s.playerId('D'), 'priority skipped B/C, landed on D')
    assert.equal(Number(p.priority_pass_count), 3, 'A + skipped B + skipped C counted')
  })
})

// PA3 — rsp opponents are never auto-skipped (they want a response window).
test('PA3 an rsp opponent is handed priority instead of being skipped', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 4)
    await s.setAutoPass('B', { op: true, rsp: true }) // wants to stop for responses
    await s.setAutoPass('C', { op: true })
    await s.setAutoPass('D', { op: true })
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    await s.passPriority('A')

    const p = await s.priorityState()
    assert.equal(p.priority_player_id, s.playerId('B'), 'B (rsp) keeps priority, not skipped')
  })
})

// PA4 — a non-empty stack disables chaining: passing hands to the next seat as
// before, so each player's stk/rsp response window stays manual.
test('PA4 a non-empty stack disables chaining (per-client passing)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 4)
    await s.setAutoPass('B', { op: true })
    await s.setAutoPass('C', { op: true })
    await s.setAutoPass('D', { op: true })
    const bear = await s.spawnCreature('B', 'Air Elemental Test')
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    // Put something on the stack so it's non-empty (a real targeted action).
    await s.as('A').putOnStack('destroy_creature', { target_card_id: bear, target_type: 'creature' })
    // Putting an action on the stack resets the priority round; re-seat A.
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    await s.passPriority('A')

    const p = await s.priorityState()
    assert.equal(p.priority_player_id, s.playerId('B'), 'no chaining: priority handed to next seat B')
    assert.equal(Number(p.priority_pass_count), 1, 'only A’s pass counted')
    const t = await s.turnStep()
    assert.equal(t.step, 'precombat_main', 'step unchanged (stack still pending)')
  })
})

// PA5 — unsynced players (default '{}' intent) are never auto-skipped, so an old
// client that never synced keeps the pre-existing behavior.
test('PA5 a player with no synced settings is not auto-skipped', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 4)
    // B left at the '{}' default; C/D would pass.
    await s.setAutoPass('C', { op: true })
    await s.setAutoPass('D', { op: true })
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    await s.passPriority('A')

    const p = await s.priorityState()
    assert.equal(p.priority_player_id, s.playerId('B'), 'B (no settings) keeps priority')
  })
})
