// Security — game-state reads are scoped to SESSION MEMBERS (mig 143). Two legacy
// USING(true) policies let anon / non-members read every game_cards + game_players
// row globally; they're dropped in favour of is_session_player gates. These tests run
// raw SELECTs under the `authenticated` role (RLS applies) as a member vs an outsider.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx, asPlayer } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

const countCards = (s: Scenario, seat: 'A' | 'B' | 'C') =>
  asPlayer(s.client, s.playerId(seat), () =>
    s.client.query<{ n: number }>(
      'select count(*)::int as n from public.game_cards where session_id = $1',
      [s.sessionId],
    ),
  ).then((r) => r.rows[0]!.n)

const countPlayers = (s: Scenario, seat: 'A' | 'B' | 'C') =>
  asPlayer(s.client, s.playerId(seat), () =>
    s.client.query<{ n: number }>(
      'select count(*)::int as n from public.game_players where session_id = $1',
      [s.sessionId],
    ),
  ).then((r) => r.rows[0]!.n)

// RLS1 — a session member can still read the session's game_cards (incl. other
// members' cards): the judge + opponent displays depend on this.
test('RLS1 a session member can read the session game cards', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client) // A + B joined; C is NOT a member
    await s.spawn('A', 'Air Elemental Test', 'hand')

    assert.ok((await countCards(s, 'B')) > 0, 'member B sees the cards')
  })
})

// RLS2 — a NON-member (C never joined) cannot read the session's game_cards at all
// (previously the USING(true) policy leaked every card globally).
test('RLS2 a non-member cannot read the session game cards', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawn('A', 'Air Elemental Test', 'hand')

    assert.equal(await countCards(s, 'C'), 0)
  })
})

// RLS3 — game_players: a member can read player state, a non-member cannot.
test('RLS3 game_players reads are member-scoped', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setMana('A', { R: 1 }) // creates A's game_players row

    assert.ok((await countPlayers(s, 'B')) > 0, 'member B sees player state')
    assert.equal(await countPlayers(s, 'C'), 0, 'non-member C sees nothing')
  })
})
