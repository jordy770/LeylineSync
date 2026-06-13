// mig 291 — static cost reductions reach command-zone casts (Nogi
// discounting a Dragon commander).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx, asPlayer, rpc } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// CC1 — with Nogi fielded ({1} off Dragon spells), a {4}{R}{R} Dragon
// commander casts from the command zone for {3}{R}{R}.
test('CC1 Nogi discounts the commander cast', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 2, { format: 'commander' })
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Nogi Test') // cost_reduction Dragon {1}
    const cmdr = await s.spawn('A', 'Lathliss Test', 'hand') // {4}{R}{R} Dragon
    await client.query(
      `update public.game_cards set zone = 'command', is_commander = true where id = $1`, [cmdr])

    await s.setMana('A', { R: 2, C: 3 }) // exactly the REDUCED cost
    await asPlayer(client, s.players.A, () =>
      rpc(client, 'cast_commander', { p_session_id: s.sessionId, p_game_card_id: cmdr, p_generic_payment: null }))

    const pool = await client.query<{ mana_pool: Record<string, number> }>(
      'select mana_pool from public.game_players where session_id = $1 and player_id = $2',
      [s.sessionId, s.players.A])
    const left = Object.values(pool.rows[0]!.mana_pool).reduce((a, b) => a + b, 0)
    assert.equal(left, 0) // {3}{R}{R} paid exactly — the {1} discount applied
    const onStack = await client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [cmdr])
    assert.equal(onStack.rows[0]!.zone, 'stack')
  })
})
