import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx, asPlayer, rpc } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => { await ensureTestCards() })

test('repro: creature attacks on its controller next turn', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A', turnNumber: 5 })
    // Enter WITHOUT dev_clear_summoning_sickness — the realistic path.
    for (let i = 0; i < 4; i++) { await s.spawn('A', 'Wastes Test', 'library'); await s.spawn('B', 'Wastes Test', 'library') }
    const grunt = await s.spawn('A', 'Dino Grunt Test', 'battlefield')
    const e1 = await client.query('select entered_battlefield_turn_number from public.game_cards where id=$1', [grunt])
    console.log('entered:', e1.rows[0].entered_battlefield_turn_number)

    // Walk the engine through A's end + B's entire turn back to A's combat.
    for (let i = 0; i < 30; i++) {
      const ts = await client.query<{ step: string; active_player_id: string; turn_number: number }>(
        'select step, active_player_id, turn_number from public.game_turn_state where session_id=$1', [s.sessionId])
      const t = ts.rows[0]!
      if (t.active_player_id === s.players.A && t.turn_number > 5 && t.step === 'declare_attackers') break
      await s.as(t.active_player_id === s.players.A ? 'A' : 'B').advanceStep()
    }
    const ts2 = await client.query('select step, turn_number from public.game_turn_state where session_id=$1', [s.sessionId])
    console.log('arrived at:', JSON.stringify(ts2.rows[0]))

    await s.as('A').declareAttacker(grunt, 'B') // must NOT be sick
    assert.ok(true)
  })
})
// The actual regression: a same-zone battlefield move (board repositioning)
// must not reset the entry stamp or tapped state.
test('same-zone battlefield move keeps the entry turn', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A', turnNumber: 9 })
    const grunt = await s.spawn('A', 'Dino Grunt Test', 'battlefield')
    await client.query('update public.game_cards set entered_battlefield_turn_number = 3, is_tapped = true where id = $1', [grunt])

    await asPlayer(client, s.players.A, () =>
      rpc(client, 'move_card_to_zone', { p_game_card_id: grunt, p_zone: 'battlefield' }))

    const r = await client.query('select entered_battlefield_turn_number, is_tapped from public.game_cards where id = $1', [grunt])
    assert.equal(r.rows[0].entered_battlefield_turn_number, 3) // NOT re-stamped to 9
    assert.equal(r.rows[0].is_tapped, true) // NOT force-untapped
  })
})
