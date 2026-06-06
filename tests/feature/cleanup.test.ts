// Operational — cleanup_finished_session (mig 144) deletes a finished game's runtime
// rows (cards/stack/effects/turn state) while keeping the session + players for
// history. Refuses non-finished sessions.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// CL1 — cleaning a finished session drops the runtime rows but keeps the session
// record and its players.
test('CL1 cleanup removes runtime data, keeps session + players', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawn('A', 'Air Elemental Test', 'battlefield')
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.markFinished()

    const res = await s.as('A').cleanupSession()
    assert.equal(res.cleaned, true)
    assert.ok(res.cards_deleted >= 1)

    // Runtime gone…
    assert.equal(await s.zoneCount('A', 'battlefield'), 0)
    const cards = await client.query<{ n: number }>(
      'select count(*)::int as n from public.game_cards where session_id = $1',
      [s.sessionId],
    )
    assert.equal(cards.rows[0]!.n, 0)
    // …session + players kept.
    assert.equal((await s.sessionResult()).status, 'finished')
    const players = await client.query<{ n: number }>(
      'select count(*)::int as n from public.game_session_players where session_id = $1',
      [s.sessionId],
    )
    assert.ok(players.rows[0]!.n >= 2)
  })
})

// CL2 — a non-finished session cannot be cleaned up.
test('CL2 cleanup refuses a non-finished session', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await assert.rejects(() => s.as('A').cleanupSession(), /finished game session can be cleaned/i)
  })
})
