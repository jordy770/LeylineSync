// Board spectator token (mig 378). The board_token on game_sessions grants
// read-only board polling to a device WITHOUT a login (TV / cast receiver):
// get_board_state_by_token gates on the token instead of membership, while
// get_board_state keeps the member gate and get_board_share_token hands the
// token only to members.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx, rpc, asPlayer } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

test('BST1 a valid token returns board state without any auth', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const { rows: [row] } = await client.query(
      'select board_token from public.game_sessions where id = $1', [s.sessionId])

    // No asPlayer wrapper: auth.uid() is null — the anon cast receiver.
    const state = await rpc<Record<string, unknown>>(client, 'get_board_state_by_token', {
      p_session_id: s.sessionId,
      p_token: row.board_token,
    })

    assert.ok(state.session, 'session bundled')
    assert.ok(Array.isArray(state.players), 'players bundled')
  })
})

test('BST2 a wrong token is rejected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await assert.rejects(
      rpc(client, 'get_board_state_by_token', {
        p_session_id: s.sessionId,
        p_token: '00000000-0000-0000-0000-000000000000',
      }),
      /Invalid board link/,
    )
  })
})

test('BST3 members fetch the share token; the member board gate is unchanged', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const { rows: [row] } = await client.query(
      'select board_token from public.game_sessions where id = $1', [s.sessionId])

    const token = await asPlayer(client, s.playerId('A'), () =>
      rpc<string>(client, 'get_board_share_token', { p_session_id: s.sessionId }))
    assert.equal(token, row.board_token)

    // get_board_state still requires membership (reproduced gate, mig 378).
    const state = await asPlayer(client, s.playerId('A'), () =>
      rpc<Record<string, unknown>>(client, 'get_board_state', { p_session_id: s.sessionId }))
    assert.ok(state.session)
  })
})
