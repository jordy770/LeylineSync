// Multi-counter model (Tier 1 + poison loss). The engine kept plus_one_counters on
// the P/T hot path untouched and added a jsonb `counters` bag on game_cards and
// game_session_players for every other kind (charge/poison/energy/…). Proliferate now
// multiplies bag counters and player counters too, and poison >= 10 loses the game.
//
// The existing proliferate.test.ts (PRO1–3) proves the +1/+1 path still works — this
// file covers the new bag/player/poison behavior. Cast as untargeted spell_effect
// programs, the same path triggered abilities use.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function setCardBag(s: Scenario, card: string, bag: Record<string, number>) {
  await s.client.query('update public.game_cards set counters = $2::jsonb where id = $1', [card, JSON.stringify(bag)])
}
async function setPlayerBag(s: Scenario, playerId: string, bag: Record<string, number>) {
  await s.client.query(
    'update public.game_session_players set counters = $3::jsonb where session_id = $1 and player_id = $2',
    [(s as unknown as { sessionId: string }).sessionId, playerId, JSON.stringify(bag)],
  )
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

// MC1 — add_counters with a counter_type writes the bag (not the +1/+1 column).
test('MC1 add_counters counter_type charge writes the bag', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const src = await s.spawnCreature('A', 'Air Elemental Test')

    await s.as('A').castSpellEffect([{ type: 'add_counters', amount: 2, counter_type: 'charge' }], src)
    await s.as('A').resolveStack()

    assert.deepEqual(await cardBag(s, src), { charge: 2 })
    assert.equal((await s.cardState(src)).plus_one_counters, 0) // +1/+1 column untouched
  })
})

// MC2 — add_player_counters puts poison on the opponent (default recipient).
test('MC2 add_player_counters poisons the opponent', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    await s.as('A').castSpellEffect([{ type: 'add_player_counters', amount: 3, counter_type: 'poison' }])
    await s.as('A').resolveStack()

    assert.equal((await playerBag(s, s.playerId('B'))).poison, 3)
    assert.deepEqual(await playerBag(s, s.playerId('A')), {}) // caster unaffected (each_opponent)
  })
})

// MC3 — proliferate multiplies a card's bag counter (and offers it as an option).
test('MC3 proliferate bumps a bag counter on a permanent', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const card = await s.spawnCreature('A', 'Air Elemental Test')
    await setCardBag(s, card, { charge: 1 })

    await s.as('A').castSpellEffect([{ type: 'proliferate' }])
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    assert.equal(d?.decision_type, 'proliferate')
    assert.equal((d?.options as { game_card_id: string }[]).some((o) => o.game_card_id === card), true)

    await s.as('A').submitDecision(d!.id, { chosen: [card] })
    assert.equal((await cardBag(s, card)).charge, 2)
  })
})

// MC4 — proliferate targets a PLAYER with a counter (the Atraxa poison wincon).
test('MC4 proliferate bumps a player poison counter', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await setPlayerBag(s, s.playerId('B'), { poison: 4 })

    await s.as('A').castSpellEffect([{ type: 'proliferate' }])
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    // Player B is offered as a proliferate option (uniform game_card_id = player id).
    assert.equal((d?.options as { game_card_id: string }[]).some((o) => o.game_card_id === s.playerId('B')), true)

    await s.as('A').submitDecision(d!.id, { chosen: [s.playerId('B')] })
    assert.equal((await playerBag(s, s.playerId('B'))).poison, 5)
  })
})

// MC5 — a player with 10+ poison counters loses; last player standing wins.
test('MC5 poison >= 10 eliminates a player', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await setPlayerBag(s, s.playerId('B'), { poison: 9 })

    // One more poison via the effect (which re-checks state) tips B over the edge.
    await s.as('A').castSpellEffect([{ type: 'add_player_counters', amount: 1, counter_type: 'poison' }])
    await s.as('A').resolveStack()

    assert.equal((await playerBag(s, s.playerId('B'))).poison, 10)
    const result = await s.sessionResult()
    assert.equal(result.status, 'finished')
    assert.equal(result.winner_player_id, s.playerId('A')) // only A is un-poisoned
  })
})

// MC6 — proliferate bumps BOTH a card's +1/+1 and its bag, in one go.
test('MC6 proliferate bumps +1/+1 and bag counters together', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const card = await s.spawnCreature('A', 'Air Elemental Test')
    await s.client.query('update public.game_cards set plus_one_counters = 2 where id = $1', [card])
    await setCardBag(s, card, { charge: 1 })

    await s.as('A').castSpellEffect([{ type: 'proliferate' }])
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { chosen: [card] })

    assert.equal((await s.cardState(card)).plus_one_counters, 3)
    assert.equal((await cardBag(s, card)).charge, 2)
  })
})
