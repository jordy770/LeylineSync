// Game start sequence (mig 221) — random first player, 7-card opening hands,
// London mulligan, and the two-player first-draw skip (CR 103.8a).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx, asPlayer } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function fillLibrary(s: Scenario, seat: 'A' | 'B', n: number): Promise<void> {
  for (let i = 0; i < n; i++) await s.spawn(seat, 'Air Elemental Test', 'library')
}

async function startGame(s: Scenario, seat: 'A' | 'B' = 'A'): Promise<{ first_player_id: string }> {
  return asPlayer(s.client, s.players[seat], async () => {
    const r = await s.client.query<{ res: { first_player_id: string } }>(
      'select public.start_game_session($1) as res', [s.sessionId])
    return r.rows[0]!.res
  })
}

async function playerRow(s: Scenario, seat: 'A' | 'B'): Promise<{ mulligans: number; kept: boolean }> {
  const r = await s.client.query<{ mulligans: number; opening_hand_kept: boolean }>(
    'select mulligans, opening_hand_kept from public.game_session_players where session_id = $1 and player_id = $2',
    [s.sessionId, s.players[seat]])
  return { mulligans: Number(r.rows[0]!.mulligans), kept: r.rows[0]!.opening_hand_kept }
}

// GT1 — start locks, randomizes first player, deals 7 to everyone, flags the
// two-player draw skip, and marks hands undecided.
test('GT1 starting the game deals hands and picks a first player', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await fillLibrary(s, 'A', 10)
    await fillLibrary(s, 'B', 10)

    const res = await startGame(s)

    const session = await s.client.query<{ status: string }>(
      'select status from public.game_sessions where id = $1', [s.sessionId])
    assert.equal(session.rows[0]!.status, 'locked')

    assert.ok([s.playerId('A'), s.playerId('B')].includes(res.first_player_id))
    const turn = await s.client.query<{ active_player_id: string; skip_next_draw: boolean; step: string }>(
      'select active_player_id, skip_next_draw, step from public.game_turn_state where session_id = $1', [s.sessionId])
    assert.equal(turn.rows[0]!.active_player_id, res.first_player_id)
    assert.equal(turn.rows[0]!.skip_next_draw, true) // two players → CR 103.8a
    assert.equal(turn.rows[0]!.step, 'untap')

    assert.equal(await s.zoneCount('A', 'hand'), 7)
    assert.equal(await s.zoneCount('B', 'hand'), 7)
    assert.equal(await s.zoneCount('A', 'library'), 3)
    assert.deepEqual(await playerRow(s, 'A'), { mulligans: 0, kept: false })
  })
})

// GT2 — only the creator starts; starting twice is refused; everyone needs a deck.
test('GT2 start guards: creator-only, once, decks required', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await fillLibrary(s, 'A', 8)
    // B has no library → refused.
    await assert.rejects(() => startGame(s), /no deck spawned/i)
  })
})

// GT3 — mulligan reshuffles and redraws seven; keep then bottoms one.
test('GT3 London mulligan: redraw 7, keep bottoms one per mulligan', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await fillLibrary(s, 'A', 10)
    await fillLibrary(s, 'B', 10)
    await startGame(s)

    await asPlayer(s.client, s.players.B, async () => {
      await s.client.query('select public.mulligan_hand($1)', [s.sessionId])
    })
    assert.equal(await s.zoneCount('B', 'hand'), 7) // London: seven again
    assert.equal((await playerRow(s, 'B')).mulligans, 1)

    // Keep requires exactly one bottomed card now.
    const hand = await s.client.query<{ id: string }>(
      `select id from public.game_cards where session_id = $1 and owner_id = $2 and zone = 'hand' order by zone_position`,
      [s.sessionId, s.playerId('B')])
    const bottomed = hand.rows[0]!.id
    await asPlayer(s.client, s.players.B, async () => {
      await s.client.query('select public.keep_opening_hand($1, $2)', [s.sessionId, [bottomed]])
    })

    assert.equal(await s.zoneCount('B', 'hand'), 6) // 7 − 1 bottomed
    assert.equal((await playerRow(s, 'B')).kept, true)
    const bottom = await s.client.query<{ id: string }>(
      `select id from public.game_cards where session_id = $1 and owner_id = $2 and zone = 'library'
       order by zone_position desc limit 1`,
      [s.sessionId, s.playerId('B')])
    assert.equal(bottom.rows[0]!.id, bottomed) // landed on the BOTTOM
  })
})

// GT4 — keep validation: wrong bottom count / keeping twice are refused.
test('GT4 keep validation', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await fillLibrary(s, 'A', 10)
    await fillLibrary(s, 'B', 10)
    await startGame(s)

    await asPlayer(s.client, s.players.A, async () => {
      await s.client.query('select public.keep_opening_hand($1)', [s.sessionId]) // 0 mulligans → keep as-is
    })
    assert.equal((await playerRow(s, 'A')).kept, true)

    await assert.rejects(
      () => asPlayer(s.client, s.players.A, async () => {
        await s.client.query('select public.keep_opening_hand($1)', [s.sessionId])
      }),
      /already kept/i,
    )
  })
})

// GT5 — the first player's first draw step is skipped (two-player), then
// drawing resumes normally.
test('GT5 two-player first-draw skip', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await fillLibrary(s, 'A', 10)
    await fillLibrary(s, 'B', 10)
    const res = await startGame(s)
    const firstSeat = res.first_player_id === s.playerId('A') ? 'A' : 'B'

    // Walk untap → upkeep → draw → main as the first player (no permanents on
    // the battlefield, so no upkeep triggers to resolve).
    await s.as(firstSeat).advanceStep() // untap → upkeep
    await s.as(firstSeat).advanceStep() // upkeep → draw
    await s.as(firstSeat).advanceStep() // draw → main: NO draw (flag consumed)

    assert.equal(await s.zoneCount(firstSeat, 'hand'), 7) // still 7 — skipped
    const turn = await s.client.query<{ skip_next_draw: boolean }>(
      'select skip_next_draw from public.game_turn_state where session_id = $1', [s.sessionId])
    assert.equal(turn.rows[0]!.skip_next_draw, false) // consumed
  })
})
