// Lobby "change deck" (mig 324) — clear_deck_from_session lets a player undo a
// lock-in (remove their spawned cards) before the game starts, so they can pick a
// different deck. It refuses once the session has left the 'open' lobby state.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx, asPlayer, rpc } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

const ownerCardCount = async (
  client: Parameters<Parameters<typeof withRolledBackTx>[0]>[0],
  sessionId: string,
  ownerId: string,
): Promise<number> => {
  const r = await client.query<{ n: number }>(
    'select count(*)::int n from public.game_cards where session_id = $1 and owner_id = $2',
    [sessionId, ownerId],
  )
  return r.rows[0].n
}

// CD1 — clearing removes only the caller's cards while the lobby is still open.
test('CD1 clear_deck_from_session removes the caller’s cards and leaves others’ alone', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawn('A', 'Air Elemental Test', 'library')
    await s.spawn('A', 'Grave Shambler Test', 'library')
    await s.spawn('B', 'Air Elemental Test', 'library') // B's deck must survive

    assert.equal(await ownerCardCount(client, s.sessionId, s.playerId('A')), 2)

    const res = await asPlayer(client, s.playerId('A'), () =>
      rpc<{ cleared: number }>(client, 'clear_deck_from_session', { p_session_id: s.sessionId }),
    )
    assert.equal(res.cleared, 2)

    assert.equal(await ownerCardCount(client, s.sessionId, s.playerId('A')), 0, 'A’s cards gone')
    assert.equal(await ownerCardCount(client, s.sessionId, s.playerId('B')), 1, 'B untouched')
  })
})

// CD2 — once the game has started (status <> 'open') the clear is refused.
test('CD2 clear_deck_from_session is rejected after the game has started', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawn('A', 'Air Elemental Test', 'library')
    await client.query("update public.game_sessions set status = 'locked' where id = $1", [s.sessionId])

    // The RPC raises before any DELETE; the rejection is the assertion (a query
    // after it would hit the now-aborted transaction).
    await assert.rejects(
      () => asPlayer(client, s.playerId('A'), () =>
        rpc(client, 'clear_deck_from_session', { p_session_id: s.sessionId })),
      /after the game has started/,
    )
  })
})
