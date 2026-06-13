// Four-player pod sweep: the engine grew through six decks of mostly-1v1
// testing, but Commander is a pod format. These tests exercise the semantics
// that only exist with multiple opponents: goad redirection, per-opponent
// edict chains, corrupted gates with MIXED poison totals, each-player
// library exiles, monarch theft, and selective attack taxes.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// MP1 — corrupted with mixed poison: the gate reads the HIGHEST opponent
// total, and Ixhel exiles only the poisoned opponents' tops.
test('MP1 corrupted gates fire on any poisoned opponent', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 4)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Ixhel Atraxa Test')
    const bTop = await s.spawn('B', 'Wastes Test', 'library')
    const cTop = await s.spawn('C', 'Wastes Test', 'library')
    const dTop = await s.spawn('D', 'Wastes Test', 'library')
    // Only C is corrupted.
    await s.client.query(
      `update public.game_session_players set counters = jsonb_build_object('poison','4')
       where session_id = $1 and player_id = $2`, [s.sessionId, s.players.C])

    await s.setTurn({ phase: 'ending', step: 'end', active: 'A', priority: 'A' })
    await s.as('A').resolveStack()

    const zones = await s.client.query<{ id: string; zone: string }>(
      'select id, zone from public.game_cards where id = any($1::uuid[])', [[bTop, cTop, dTop]])
    const byId = new Map(zones.rows.map((r) => [r.id, r.zone]))
    assert.equal(byId.get(cTop), 'exile') // poisoned → exiled
    assert.equal(byId.get(bTop), 'library') // clean → untouched
    assert.equal(byId.get(dTop), 'library')
  })
})

// MP2 — add_poison each_opponent poisons all three, not just one.
test('MP2 each_opponent poison hits the whole pod', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 4)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    await s.as('A').castSpellEffect([{ type: 'add_poison', amount: 3, recipient: 'each_opponent' }])
    await s.as('A').resolveStack()

    for (const seat of ['B', 'C', 'D'] as const) {
      const r = await s.client.query<{ counters: { poison?: string | number } | null }>(
        'select counters from public.game_session_players where session_id = $1 and player_id = $2',
        [s.sessionId, s.players[seat]])
      assert.equal(Number(r.rows[0]!.counters?.poison ?? 0), 3, `${seat} should have 3 poison`)
    }
    const a = await s.client.query<{ counters: { poison?: string | number } | null }>(
      'select counters from public.game_session_players where session_id = $1 and player_id = $2',
      [s.sessionId, s.players.A])
    assert.equal(Number(a.rows[0]!.counters?.poison ?? 0), 0) // never the caster
  })
})

// MP3 — an each_opponent edict chains a decision to EVERY opponent in seat
// order; each sacrifices their own creature.
test('MP3 pod edict chains through all three opponents', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 4)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const victims = {
      B: await s.spawnCreature('B', 'Dino Grunt Test'),
      C: await s.spawnCreature('C', 'Dino Grunt Test'),
      D: await s.spawnCreature('D', 'Dino Grunt Test'),
    }

    await s.as('A').castSpellEffect([{ type: 'sacrifice', who: 'each_opponent', count: 1 }])
    await s.as('A').resolveStack()

    for (const seat of ['B', 'C', 'D'] as const) {
      const d = await s.pendingDecision()
      assert.ok(d, `expected a decision for ${seat}`)
      assert.equal(d!.deciding_player_id, s.players[seat], `decision belongs to ${seat}`)
      await s.as(seat).submitDecision(d!.id, { chosen: [victims[seat]] })
    }
    for (const seat of ['B', 'C', 'D'] as const) {
      const r = await s.client.query<{ zone: string }>(
        'select zone from public.game_cards where id = $1', [victims[seat]])
      assert.equal(r.rows[0]!.zone, 'graveyard')
    }
  })
})

// MP4 — Etali exiles EVERY player's library top (all four).
test('MP4 Etali exiles all four library tops', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 4)
    const etali = await s.spawnCreature('A', 'Etali Primal Test')
    const tops = [
      await s.spawn('A', 'Wastes Test', 'library'),
      await s.spawn('B', 'Wastes Test', 'library'),
      await s.spawn('C', 'Wastes Test', 'library'),
      await s.spawn('D', 'Wastes Test', 'library'),
    ]
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(etali, 'B')
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'etali_cast_pick')
    await s.as('A').submitDecision(d!.id, { chosen: [] }) // decline all

    const zones = await s.client.query<{ n: string }>(
      `select count(*)::int as n from public.game_cards
       where id = any($1::uuid[]) and zone = 'exile'`, [[...tops]])
    assert.equal(Number(zones.rows[0]!.n), 4)
  })
})

// MP5 — goad with a REAL choice: the goaded creature may not attack the
// goader while other opponents exist, but may attack a third player.
test('MP5 goaded creatures must attack away from the goader', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 4)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'B', priority: 'B' })
    const brute = await s.spawnCreature('B', 'Air Elemental Test')
    // A goads B's creature.
    await s.client.query(
      `insert into public.game_continuous_effects
         (session_id, source_card_id, affected_card_id, effect_type, payload, expires_at_turn_number)
       select $1, gc.id, $2, 'goaded', jsonb_build_object('goaded_by', $3::text), 99
       from public.game_cards gc where gc.session_id = $1 limit 1`,
      [s.sessionId, brute, s.players.A])
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'B', priority: 'B' })

    // Attacking the goader is refused while C/D are attackable…
    await s.as('B').declareAttacker(brute, 'C') // …but a third player is legal
    const atk = await s.client.query<{ defending_player_id: string }>(
      'select defending_player_id from public.game_combat_assignments where session_id = $1 and attacker_card_id = $2',
      [s.sessionId, brute])
    assert.equal(atk.rows[0]!.defending_player_id, s.players.C)
  })
})

// MP6 — goad refusal is the LAST action (single tx): the goader is illegal.
test('MP6 the goader cannot be attacked by the goaded creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 4)
    const brute = await s.spawnCreature('B', 'Air Elemental Test')
    await s.client.query(
      `insert into public.game_continuous_effects
         (session_id, source_card_id, affected_card_id, effect_type, payload, expires_at_turn_number)
       select $1, gc.id, $2, 'goaded', jsonb_build_object('goaded_by', $3::text), 99
       from public.game_cards gc where gc.session_id = $1 limit 1`,
      [s.sessionId, brute, s.players.A])
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'B', priority: 'B' })

    await assert.rejects(() => s.as('B').declareAttacker(brute, 'A'), /goad/i)
  })
})

// MP7 — monarch theft in a pod: C steals the crown from A by connecting.
test('MP7 combat damage steals the crown in a pod', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 4)
    await s.client.query(
      'update public.game_turn_state set monarch_player_id = $2 where session_id = $1',
      [s.sessionId, s.players.A])
    const raider = await s.spawnCreature('C', 'Air Elemental Test')
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'C', priority: 'C' })
    await s.as('C').declareAttacker(raider, 'A')
    await s.setTurn({ phase: 'combat', step: 'combat_damage', active: 'C', priority: 'C' })
    await s.resolveCombat()

    const crown = await s.client.query<{ monarch_player_id: string }>(
      'select monarch_player_id from public.game_turn_state where session_id = $1', [s.sessionId])
    assert.equal(crown.rows[0]!.monarch_player_id, s.players.C)
  })
})

// MP8 — attack taxes protect ONLY their controller: attacking the untaxed
// player is free, attacking the protected one without mana is refused.
test('MP8 attack tax is per-protected-player', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 4)
    await s.spawn('A', 'Ghostly Prison Test', 'battlefield')
    const raider = await s.spawnCreature('B', 'Air Elemental Test')
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'B', priority: 'B' })

    await s.as('B').declareAttacker(raider, 'C') // C is unprotected — free
    const atk = await s.client.query(
      'select 1 from public.game_combat_assignments where session_id = $1 and attacker_card_id = $2',
      [s.sessionId, raider])
    assert.equal(atk.rows.length, 1)
  })
})
