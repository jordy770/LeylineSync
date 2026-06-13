// mig 249 — Vengeful Ancestor (goad) + Territorial Hellkite.
//   • goad: a 'goaded' row carrying the goader, expiring before the goader's
//     next turn; declare_attacker rejects attacking the goader while another
//     opponent exists; "whenever a goaded creature attacks, it deals 1 damage
//     to its controller" via the goaded watcher filter +
//     recipient:'triggering_controller'. (Attack-each-combat not forced.)
//   • Territorial Hellkite: at the beginning of combat, a random opponent it
//     didn't attack last combat is pinned as this combat's defender
//     (must_attack marker); no legal pick taps it.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// VA1 — ETB goads the picked creature; the goaded row carries the goader and
// an expiry one full round away.
test('VA1 Vengeful Ancestor goads the targeted creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const victim = await s.spawnCreature('B', 'Dragon Token')
    await s.spawnCreature('A', 'Vengeful Ancestor Test')

    const trigger = await s.client.query<{ id: string }>(
      `select id from public.game_stack_items
       where session_id = $1 and status = 'pending' and action_type = 'triggered_ability'
       order by position desc limit 1`,
      [s.sessionId])
    await s.as('A').chooseTriggerTarget(trigger.rows[0]!.id, victim)
    await s.as('A').resolveStack()

    const row = await s.client.query<{ payload: { goaded_by: string }; exp: number }>(
      `select payload, expires_at_turn_number as exp from public.game_continuous_effects
       where session_id = $1 and effect_type = 'goaded' and affected_card_id = $2`,
      [s.sessionId, victim])
    assert.equal(row.rows.length, 1)
    assert.equal(row.rows[0]!.payload.goaded_by, s.players.A)
    assert.equal(row.rows[0]!.exp, 2) // turn 1 + (2 players - 1)
  })
})

// VA2 — when the goaded creature attacks, its controller takes 1.
test('VA2 a goaded creature attacking costs its controller 1 life', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const victim = await s.spawnCreature('B', 'Dragon Token')
    await s.spawnCreature('A', 'Vengeful Ancestor Test')
    const trigger = await s.client.query<{ id: string }>(
      `select id from public.game_stack_items
       where session_id = $1 and status = 'pending' and action_type = 'triggered_ability'
       order by position desc limit 1`,
      [s.sessionId])
    await s.as('A').chooseTriggerTarget(trigger.rows[0]!.id, victim)
    await s.as('A').resolveStack()

    const before = await s.client.query<{ life_total: number }>(
      'select life_total from public.game_session_players where session_id = $1 and player_id = $2',
      [s.sessionId, s.players.B])

    // B's turn: the goaded Dragon attacks (A is the only opponent, so
    // attacking the goader is legal — "a player other than you IF ABLE").
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'B', priority: 'B', turnNumber: 2 })
    await s.as('B').declareAttacker(victim, 'A')
    await s.as('B').resolveStack() // the Vengeful Ancestor watcher

    const after = await s.client.query<{ life_total: number }>(
      'select life_total from public.game_session_players where session_id = $1 and player_id = $2',
      [s.sessionId, s.players.B])
    assert.equal(after.rows[0]!.life_total, before.rows[0]!.life_total - 1)
  })
})

// TH1 — combat begins: the only fresh opponent is pinned; attacking them
// works and stamps the last-combat memory.
test('TH1 Territorial Hellkite pins a fresh opponent and remembers it', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'beginning', step: 'upkeep', active: 'A', priority: 'A' })
    const kite = await s.spawnCreature('A', 'Territorial Hellkite Test')

    await s.setTurn({ phase: 'combat', step: 'beginning_of_combat', active: 'A', priority: 'A' })
    await s.as('A').resolveStack() // the territorial trigger

    let row = await s.client.query<{ ma: string | null }>(
      `select counters ->> 'must_attack' as ma from public.game_cards where id = $1`, [kite])
    assert.equal(row.rows[0]!.ma, s.players.B)

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(kite, 'B')
    row = await s.client.query<{ ma: string | null }>(
      `select counters ->> 'last_attacked' as ma from public.game_cards where id = $1`, [kite])
    assert.equal(row.rows[0]!.ma, s.players.B)
  })
})

// TH2 — every opponent was attacked last combat: no legal pick, so it taps.
test('TH2 Territorial Hellkite taps when no fresh opponent exists', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'beginning', step: 'upkeep', active: 'A', priority: 'A' })
    const kite = await s.spawnCreature('A', 'Territorial Hellkite Test')
    await s.client.query(
      `update public.game_cards set counters = coalesce(counters, '{}'::jsonb)
         || jsonb_build_object('last_attacked', $2::text) where id = $1`,
      [kite, s.players.B])

    await s.setTurn({ phase: 'combat', step: 'beginning_of_combat', active: 'A', priority: 'A' })
    await s.as('A').resolveStack()

    const row = await s.client.query<{ is_tapped: boolean }>(
      'select is_tapped from public.game_cards where id = $1', [kite])
    assert.equal(row.rows[0]!.is_tapped, true)
  })
})
