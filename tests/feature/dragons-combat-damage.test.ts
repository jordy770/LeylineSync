// mig 247 — Broodcaller Scourge + Parapet Thrasher: "Whenever one or more
// Dragons you control deal combat damage to a player/an opponent …".
//   • resolve_combat_damage tallies Dragon combat damage per damaged player
//     and broadcasts a dragons_combat_damage trigger carrying event_amount.
//   • Broodcaller: put a hand permanent with MV <= that damage onto the
//     battlefield (parked pick, declinable).
//   • Parapet: modal — destroy an opponent artifact (parked pick) / 4 damage
//     to each opponent / impulse 1. (Approximations: no once-per-turn mode
//     memory; "each OTHER opponent" hits each opponent; "that opponent" is
//     any opponent.)

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// BS1 — a 4/4 Dragon connects for 4: the pick offers MV<=4 hand permanents
// only, and the chosen one enters the battlefield.
test('BS1 Broodcaller puts a hand permanent up to the damage dealt', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    const brood = await s.spawnCreature('A', 'Broodcaller Scourge Test') // 4/4 Dragon
    const cheap = await s.spawn('A', 'Leyline Tyrant Test', 'hand') // MV 4
    await s.spawn('A', 'Hammerhead Tyrant Test', 'hand') // MV 6 — over the cap

    await s.as('A').declareAttacker(brood, 'B')
    await s.setTurn({ phase: 'combat', step: 'combat_damage', active: 'A', priority: 'A' })
    await s.as('A').resolveCombat() // 4 to B -> dragons_combat_damage trigger
    await s.as('A').resolveStack()

    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'put_from_hand_pick')
    const offered = (d!.options as { game_card_id: string }[]).map((o) => o.game_card_id)
    assert.deepEqual(offered, [cheap]) // the MV-6 card is not offered
    await s.as('A').submitDecision(d!.id, { chosen: [cheap] })

    const row = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [cheap])
    assert.equal(row.rows[0]!.zone, 'battlefield')
  })
})

// PT1 — Parapet connects; the destroy-artifact mode parks a pick over the
// opponent's artifacts (nested parking through the modal splice).
test('PT1 Parapet Thrasher modal destroys an opponent artifact', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    const parapet = await s.spawnCreature('A', 'Parapet Thrasher Test') // 4/4 Dragon
    const treasure = await s.spawn('B', 'Treasure Token', 'battlefield') // artifact

    await s.as('A').declareAttacker(parapet, 'B')
    await s.setTurn({ phase: 'combat', step: 'combat_damage', active: 'A', priority: 'A' })
    await s.as('A').resolveCombat()
    await s.as('A').resolveStack()

    let d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'choose_mode')
    await s.as('A').submitDecision(d!.id, { chosen: [0] }) // destroy mode

    d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'destroy_pick')
    const offered = (d!.options as { game_card_id: string }[]).map((o) => o.game_card_id)
    assert.deepEqual(offered, [treasure])
    await s.as('A').submitDecision(d!.id, { chosen: [treasure] })

    const gone = await s.client.query('select 1 from public.game_cards where id = $1', [treasure])
    assert.equal(gone.rows.length, 0) // a destroyed token ceases
  })
})

// PT2 — the damage mode: 4 to each opponent (the only opponent here).
test('PT2 Parapet Thrasher damage mode hits the opponent', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    const parapet = await s.spawnCreature('A', 'Parapet Thrasher Test')

    const before = await s.client.query<{ life_total: number }>(
      'select life_total from public.game_session_players where session_id = $1 and player_id = $2',
      [s.sessionId, s.players.B])

    await s.as('A').declareAttacker(parapet, 'B')
    await s.setTurn({ phase: 'combat', step: 'combat_damage', active: 'A', priority: 'A' })
    await s.as('A').resolveCombat() // 4 combat damage
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { chosen: [1] }) // 4 to each opponent

    const after = await s.client.query<{ life_total: number }>(
      'select life_total from public.game_session_players where session_id = $1 and player_id = $2',
      [s.sessionId, s.players.B])
    assert.equal(after.rows[0]!.life_total, before.rows[0]!.life_total - 4 - 4) // combat + mode
  })
})
