// Counter removal (roadmap Counters #1). Reuses the add_counters pipeline: a NEGATIVE
// amount subtracts, `all: true` clears a kind. Works for +1/+1 (fast column) and bag
// counters, on a source/target/player. Removing +1/+1 lowers toughness, so it re-runs
// the lethal SBA. Also covers the judge RPCs (adjust_card_bag_counter / adjust_player_counter).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx, asPlayer, rpc } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function setCardBag(s: Scenario, card: string, bag: Record<string, number>) {
  await s.client.query('update public.game_cards set counters = $2::jsonb where id = $1', [card, JSON.stringify(bag)])
}
async function cardBag(s: Scenario, card: string): Promise<Record<string, number>> {
  const r = await s.client.query<{ counters: Record<string, number> }>('select counters from public.game_cards where id = $1', [card])
  return r.rows[0]?.counters ?? {}
}
async function playerBag(s: Scenario, playerId: string): Promise<Record<string, number>> {
  const r = await s.client.query<{ counters: Record<string, number> }>(
    'select counters from public.game_session_players where session_id = $1 and player_id = $2',
    [(s as unknown as { sessionId: string }).sessionId, playerId],
  )
  return r.rows[0]?.counters ?? {}
}

// RM1 — a negative amount removes +1/+1 counters from the source.
test('RM1 add_counters with negative amount removes +1/+1', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const src = await s.spawnCreature('A', 'Air Elemental Test')
    await s.client.query('update public.game_cards set plus_one_counters = 3 where id = $1', [src])

    await s.as('A').castSpellEffect([{ type: 'add_counters', amount: -2 }], src)
    await s.as('A').resolveStack()

    assert.equal((await s.cardState(src)).plus_one_counters, 1)
  })
})

// RM2 — `all: true` clears every counter of that kind (here a bag counter).
test('RM2 add_counters all clears a bag counter kind', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const src = await s.spawnCreature('A', 'Air Elemental Test')
    await setCardBag(s, src, { charge: 4 })

    await s.as('A').castSpellEffect([{ type: 'add_counters', all: true, counter_type: 'charge' }], src)
    await s.as('A').resolveStack()

    assert.deepEqual(await cardBag(s, src), {}) // charge key dropped entirely
  })
})

// RM3 — removing +1/+1 lowers toughness; a creature now under its marked damage dies.
test('RM3 removing +1/+1 re-runs the lethal SBA', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const src = await s.spawnCreature('A', 'Air Elemental Test') // base 4/4
    // 4/4 + 2 counters = 6 toughness, 5 marked damage → survives.
    await s.client.query('update public.game_cards set plus_one_counters = 2, damage_marked = 5 where id = $1', [src])
    assert.equal(await s.zoneOf(src), 'battlefield')

    // Remove both counters → toughness 4, 5 damage ≥ 4 → lethal.
    await s.as('A').castSpellEffect([{ type: 'add_counters', amount: -2 }], src)
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(src), 'graveyard')
  })
})

// RM4 — player counters can be removed too (leeches: "remove a poison counter").
test('RM4 add_player_counters negative removes poison', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.client.query(
      "update public.game_session_players set counters = '{\"poison\":5}'::jsonb where session_id = $1 and player_id = $2",
      [(s as unknown as { sessionId: string }).sessionId, s.playerId('A')],
    )

    // Controller removes 2 of their own poison.
    await s.as('A').castSpellEffect([{ type: 'add_player_counters', amount: -2, counter_type: 'poison', recipient: 'controller' }])
    await s.as('A').resolveStack()

    assert.equal((await playerBag(s, s.playerId('A'))).poison, 3)
  })
})

// RM5 — judge RPC adjust_card_bag_counter dials a bag counter on a card.
test('RM5 judge adjust_card_bag_counter', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const src = await s.spawnCreature('A', 'Air Elemental Test')

    await asPlayer(client, s.playerId('A'), () =>
      rpc(client, 'adjust_card_bag_counter', { p_session_id: (s as unknown as { sessionId: string }).sessionId, p_game_card_id: src, p_kind: 'charge', p_delta: 2 }),
    )
    assert.equal((await cardBag(s, src)).charge, 2)

    await asPlayer(client, s.playerId('A'), () =>
      rpc(client, 'adjust_card_bag_counter', { p_session_id: (s as unknown as { sessionId: string }).sessionId, p_game_card_id: src, p_kind: 'charge', p_delta: -2 }),
    )
    assert.deepEqual(await cardBag(s, src), {}) // back to empty
  })
})

// RM6 — judge RPC adjust_player_counter; reaching 10 poison ends the game.
test('RM6 judge adjust_player_counter to 10 poison eliminates', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const sid = (s as unknown as { sessionId: string }).sessionId
    await client.query(
      "update public.game_session_players set counters = '{\"poison\":9}'::jsonb where session_id = $1 and player_id = $2",
      [sid, s.playerId('B')],
    )

    await asPlayer(client, s.playerId('A'), () =>
      rpc(client, 'adjust_player_counter', { p_session_id: sid, p_player_id: s.playerId('B'), p_kind: 'poison', p_delta: 1 }),
    )

    assert.equal((await playerBag(s, s.playerId('B'))).poison, 10)
    const result = await s.sessionResult()
    assert.equal(result.status, 'finished')
    assert.equal(result.winner_player_id, s.playerId('A'))
  })
})
