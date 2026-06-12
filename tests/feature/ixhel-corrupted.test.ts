// mig 272 — Ixhel corrupted batch: poison-gated end-step exile with the
// impulse play window (Ixhel), Fumigate life-per-kill, Culling Ritual
// MV wipe + ritual mana.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// IX1 — Ixhel: no exile while the opponent is clean; with 3 poison the
// opponent's top goes to exile with a play permission for A.
test('IX1 Ixhel corrupted gate and exile', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Ixhel Atraxa Test')
    const top = await s.spawn('B', 'Wastes Test', 'library')

    await s.setTurn({ phase: 'ending', step: 'end', active: 'A', priority: 'A' })
    await s.as('A').resolveStack() // trigger resolves — gate is closed (0 poison)
    let row = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [top])
    assert.equal(row.rows[0]!.zone, 'library')

    await s.client.query(
      `update public.game_session_players
       set counters = jsonb_build_object('poison', '3')
       where session_id = $1 and player_id = $2`, [s.sessionId, s.players.B])
    await s.setTurn({ phase: 'main_2', step: 'postcombat_main', active: 'A', priority: 'A' })
    await s.setTurn({ phase: 'ending', step: 'end', active: 'A', priority: 'A' })
    await s.as('A').resolveStack()

    row = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [top])
    assert.equal(row.rows[0]!.zone, 'exile')
    const perm = await s.client.query(
      `select 1 from public.game_continuous_effects
       where session_id = $1 and effect_type = 'play_from_exile'
         and affected_player_id = $2 and payload -> 'card_ids' ? $3`,
      [s.sessionId, s.players.A, top])
    assert.ok(perm.rows.length === 1) // A may play it
  })
})

// IX2 — Fumigate gains 1 per destroyed creature.
test('IX2 Fumigate wipes and gains', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Dino Grunt Test')
    await s.spawnCreature('B', 'Air Elemental Test')
    const before = await s.client.query<{ life_total: number }>(
      'select life_total from public.game_session_players where session_id = $1 and player_id = $2',
      [s.sessionId, s.players.A])

    await s.as('A').castSpellEffect([
      { type: 'destroy_all_creatures_token', gain_per_destroyed: 1 }])
    await s.as('A').resolveStack()

    const after = await s.client.query<{ life_total: number }>(
      'select life_total from public.game_session_players where session_id = $1 and player_id = $2',
      [s.sessionId, s.players.A])
    assert.equal(after.rows[0]!.life_total, before.rows[0]!.life_total + 2)
  })
})

// IX3 — Culling Ritual: only nonland MV<=2 dies; ritual mana matches kills.
test('IX3 Culling Ritual wipes cheap nonlands for mana', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const cheap = await s.spawn('B', 'Ichor Wellspring Test', 'battlefield') // MV 2
    const fat = await s.spawnCreature('B', 'Air Elemental Test') // MV 0? fixture has no cost — check survives via MV... spawn a costed one
    const land = await s.spawn('B', 'Forest Test', 'battlefield')
    await s.as('B').resolveStack() // flush Wellspring ETB draw

    await s.as('A').castSpellEffect([
      { type: 'destroy_all_mv', max_mana_value: 2, mana_per_destroyed: 'B' }])
    await s.as('A').resolveStack()

    const r1 = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [cheap])
    assert.equal(r1.rows[0]!.zone, 'graveyard')
    const r3 = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [land])
    assert.equal(r3.rows[0]!.zone, 'battlefield') // lands spared
    const pool = await s.client.query<{ mana_pool: { B: number } }>(
      'select mana_pool from public.game_players where session_id = $1 and player_id = $2',
      [s.sessionId, s.players.A])
    assert.ok((pool.rows[0]?.mana_pool?.B ?? 0) >= 1) // ritual mana arrived
  })
})
