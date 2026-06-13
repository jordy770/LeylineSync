// mig 250 — Scourge of the Throne: dethrone + an additional combat phase.
//   • fire_attack_triggers stamps the defender (event_player_id);
//     if_attacking_most_life runs its inner effects only when that defender
//     has the most life or is tied for it (once_per_turn for the extra
//     combat, approximated as the first QUALIFYING attack).
//   • extra_combat queues a combat phase; advance_step loops end_of_combat
//     back to beginning_of_combat, consuming one.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// ST1 — attacking the (tied-for) most-life player: dethrone counter, every
// attacker untaps, and one extra combat phase is queued and consumed.
test('ST1 Scourge dethrones and grants an extra combat', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    const scourge = await s.spawnCreature('A', 'Scourge of the Throne Test')

    await s.as('A').declareAttacker(scourge, 'B') // equal life: tied for most
    await s.as('A').resolveStack() // the attacks trigger

    const row = await s.client.query<{ plus_one_counters: number; is_tapped: boolean }>(
      'select plus_one_counters, is_tapped from public.game_cards where id = $1', [scourge])
    assert.equal(row.rows[0]!.plus_one_counters, 1) // dethrone
    assert.equal(row.rows[0]!.is_tapped, false) // untap all attackers
    const ts = await s.client.query<{ extra_combats: number }>(
      'select extra_combats from public.game_turn_state where session_id = $1', [s.sessionId])
    assert.equal(ts.rows[0]!.extra_combats, 1)

    // The end of combat loops back into a fresh combat, consuming the extra.
    await s.setTurn({ phase: 'combat', step: 'end_of_combat', active: 'A', priority: 'A' })
    let st = await s.as('A').advanceStep('A')
    assert.equal(st.step, 'beginning_of_combat')
    await s.setTurn({ phase: 'combat', step: 'end_of_combat', active: 'A', priority: 'A' })
    st = await s.as('A').advanceStep('A')
    assert.equal(st.step, 'postcombat_main')
  })
})

// ST2 — the defender is NOT the life leader: nothing happens.
test('ST2 Scourge does nothing against a lower-life defender', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    const scourge = await s.spawnCreature('A', 'Scourge of the Throne Test')
    await s.client.query(
      'update public.game_session_players set life_total = 10 where session_id = $1 and player_id = $2',
      [s.sessionId, s.players.B])

    await s.as('A').declareAttacker(scourge, 'B')
    await s.as('A').resolveStack()

    const row = await s.client.query<{ plus_one_counters: number }>(
      'select plus_one_counters from public.game_cards where id = $1', [scourge])
    assert.equal(row.rows[0]!.plus_one_counters, 0)
    const ts = await s.client.query<{ extra_combats: number }>(
      'select extra_combats from public.game_turn_state where session_id = $1', [s.sessionId])
    assert.equal(ts.rows[0]!.extra_combats, 0)
  })
})
