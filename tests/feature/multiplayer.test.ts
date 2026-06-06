// Commander (EDH) — multiplayer turn/priority/win loop (mig 140). The turn and
// priority engines rotate by seat_number and were already generically N-player,
// and maybe_finish_game_session already implements last-player-standing. The gap:
// neither pass_priority nor advance_step skipped ELIMINATED players (life 0). In a
// 2-player game that's invisible (the game ends the instant one dies), but in 3-4
// player Commander the game CONTINUES and a dead seat would still be handed
// priority (stalling the round) and become the active player (untap/draw for a
// corpse). mig 140 adds an `life_total > 0` filter to both rotations + the
// pass-count threshold. These tests prove the full 4-player loop.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario, type Seat } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// MP1 — the turn passes around all four seats in order and wraps D -> A.
test('MP1 four-player turn rotation wraps A->B->C->D->A', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 4)
    const order: [Seat, Seat][] = [
      ['A', 'B'],
      ['B', 'C'],
      ['C', 'D'],
      ['D', 'A'],
    ]
    for (const [active, next] of order) {
      await s.setTurn({ phase: 'ending', step: 'cleanup', active, priority: active })
      const ts = await s.advanceStep(active)
      assert.equal(ts.active_player_id, s.playerId(next), `${active} -> ${next}`)
    }
  })
})

// MP2 — a priority round only completes once ALL FOUR players pass in a row.
test('MP2 a four-player priority round needs all four passes to resolve', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 4)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Air Elemental Test', 'library') // something to draw

    await s.as('A').putOnStack('draw_cards', { amount: 1 })
    await s.passPriority('A') // -> B, count 1
    await s.passPriority('B') // -> C, count 2
    await s.passPriority('C') // -> D, count 3
    assert.equal(await s.pendingCount(), 1) // still pending after three passes

    await s.passPriority('D') // count 4 == players -> resolves
    assert.equal(await s.pendingCount(), 0)
  })
})

// MP3 — an eliminated player is skipped in the priority round, and the round
// completes after the THREE surviving players pass (not four).
test('MP3 priority skips an eliminated player', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 4)
    await s.eliminate('C') // 3 alive; game continues
    assert.equal((await s.sessionResult()).status, 'open')

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Air Elemental Test', 'library')

    await s.as('A').putOnStack('draw_cards', { amount: 1 })
    await s.passPriority('A') // -> B, count 1
    const afterB = await s.priorityState()
    await s.passPriority('B') // must skip C -> D, count 2
    const afterBPass = await s.priorityState()
    assert.equal(afterBPass.priority_player_id, s.playerId('D'), 'C is skipped')
    assert.notEqual(afterB.priority_player_id, s.playerId('C'))

    await s.passPriority('D') // count 3 == alive -> resolves
    assert.equal(await s.pendingCount(), 0)
  })
})

// MP4 — the active-player rotation skips an eliminated seat at end of turn.
test('MP4 turn rotation skips an eliminated player', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 4)
    await s.eliminate('C')

    await s.setTurn({ phase: 'ending', step: 'cleanup', active: 'B', priority: 'B' })
    const ts = await s.advanceStep('B')
    assert.equal(ts.active_player_id, s.playerId('D'), 'B -> D (C skipped)')
  })
})

// MP5 — last player standing: once only one seat has life, the session finishes
// with that seat as the winner.
test('MP5 last player standing wins', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 4)
    await s.eliminate('B')
    await s.eliminate('C')
    assert.equal((await s.sessionResult()).status, 'open') // A and D remain

    await s.eliminate('D') // only A alive -> finish

    const result = await s.sessionResult()
    assert.equal(result.status, 'finished')
    assert.equal(result.winner_player_id, s.playerId('A'))
  })
})
