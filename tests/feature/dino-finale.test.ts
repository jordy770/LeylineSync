// mig 262 — Veloci-Ramp-Tor finale (deck complete). Engine touches:
//   • monarch subsystem: become_monarch, combat-damage steal, end-step draw,
//     monarch_land_bonus extra mana (Regal Behemoth)
//   • exile_tops_cast + etali_cast_pick (Etali, Primal Storm)
//   • exile_until_leaves + return on source leaving (Bronzebeak Foragers)

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx, asPlayer, rpc } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// FN1 — Etali exiles every library top and free-casts the chosen permanents.
test('FN1 Etali casts both exiled tops for free', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const etali = await s.spawnCreature('A', 'Etali Primal Test')
    const mineTop = await s.spawn('A', 'Dino Grunt Test', 'library')
    const theirsTop = await s.spawn('B', 'Air Elemental Test', 'library')
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })

    await s.as('A').declareAttacker(etali, 'B')
    await s.as('A').resolveStack() // the attack trigger → exile + park
    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'etali_cast_pick')
    await s.as('A').submitDecision(d!.id, { chosen: [mineTop, theirsTop] })

    const rows = await s.client.query<{ id: string; zone: string; controller_player_id: string }>(
      'select id, zone, controller_player_id from public.game_cards where id = any($1::uuid[])',
      [[mineTop, theirsTop]])
    for (const r of rows.rows) {
      assert.equal(r.zone, 'battlefield')
      assert.equal(r.controller_player_id, s.players.A) // B's card too — stolen cast
    }
  })
})

// FN2 — Regal Behemoth crowns you; tapping a land then yields double mana on
// BOTH land paths (scripted mana ability and the basic-land rpc).
test('FN2 Regal Behemoth monarch and land bonus', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const kessig = await s.spawn('A', 'Kessig Wolf Run Test', 'battlefield')
    const forest = await s.spawn('A', 'Forest Test', 'battlefield')
    await s.spawnCreature('A', 'Regal Behemoth Test')
    await s.as('A').resolveStack() // ETB → become the monarch

    const crown = await s.client.query<{ monarch_player_id: string }>(
      'select monarch_player_id from public.game_turn_state where session_id = $1', [s.sessionId])
    assert.equal(crown.rows[0]!.monarch_player_id, s.players.A)

    const pool = await s.as('A').activateMana(kessig) // scripted {T}: add {C}
    assert.equal(pool.C, 2) // 1 from Kessig + 1 monarch bonus

    const pool2 = await asPlayer(s.client, s.players.A, () =>
      rpc<Record<string, number>>(s.client, 'add_mana_from_card', {
        p_game_card_id: forest, p_session_id: s.sessionId,
        p_player_id: s.players.A, p_color: 'G', p_amount: 1,
        p_should_tap_card: true, // disambiguates from the legacy 5-arg overload
      })) // the basic-land path
    assert.equal(pool2.G, 2) // 1 from the Forest + 1 monarch bonus
  })
})

// FN3 — combat damage to the monarch steals the crown.
test('FN3 combat damage steals the monarchy', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.client.query(
      'update public.game_turn_state set monarch_player_id = $2 where session_id = $1',
      [s.sessionId, s.players.A])
    const raider = await s.spawnCreature('B', 'Air Elemental Test')
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'B', priority: 'B' })
    await s.as('B').declareAttacker(raider, 'A')
    await s.setTurn({ phase: 'combat', step: 'combat_damage', active: 'B', priority: 'B' })
    await s.resolveCombat()

    const crown = await s.client.query<{ monarch_player_id: string }>(
      'select monarch_player_id from public.game_turn_state where session_id = $1', [s.sessionId])
    assert.equal(crown.rows[0]!.monarch_player_id, s.players.B)
  })
})

// FN4 — the monarch draws at their own end step.
test('FN4 the monarch draws at their end step', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.client.query(
      'update public.game_turn_state set monarch_player_id = $2 where session_id = $1',
      [s.sessionId, s.players.A])
    await s.spawn('A', 'Wastes Test', 'library')
    await s.setTurn({ phase: 'main_2', step: 'postcombat_main', active: 'A', priority: 'A' })

    await s.as('A').advanceStep() // → end step, monarch draw

    const hand = await s.client.query<{ n: string }>(
      `select count(*)::int as n from public.game_cards
       where session_id = $1 and owner_id = $2 and zone = 'hand'`,
      [s.sessionId, s.players.A])
    assert.equal(Number(hand.rows[0]!.n), 1)
  })
})

// FN5 — Bronzebeak exiles an opposing creature until it leaves, then returns it.
test('FN5 Bronzebeak exile-until-leaves round trip', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const victim = await s.spawnCreature('B', 'Air Elemental Test')

    const foragers = await s.spawnCreature('A', 'Bronzebeak Foragers Test')
    const item = await s.topStackItem()
    assert.equal(item?.action_type, 'triggered_ability')
    await s.as('A').chooseTriggerTarget(item!.id, victim)
    await s.as('A').resolveStack()

    const exiled = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [victim])
    assert.equal(exiled.rows[0]!.zone, 'exile')

    await s.putInGraveyard(foragers) // the source leaves → the exile returns
    const back = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [victim])
    assert.equal(back.rows[0]!.zone, 'battlefield')
  })
})
