// mig 283 — lifelink and the becomes_tapped event.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

const lifeOf = async (s: Scenario, seat: 'A' | 'B') => {
  const r = await s.client.query<{ life_total: number }>(
    'select life_total from public.game_session_players where session_id = $1 and player_id = $2',
    [s.sessionId, s.players[seat]])
  return r.rows[0]!.life_total
}

// LT1 — a Warhammer-equipped attacker connects: damage AND that much life.
test('LT1 lifelink pays the controller on combat damage', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const hammer = await s.spawn('A', 'Loxodon Warhammer Test', 'battlefield')
    const brute = await s.spawnCreature('A', 'Dino Grunt Test') // 3/3 → 6/3
    await s.setMana('A', { C: 3 })
    await s.as('A').activate(hammer, 0, { targetCardId: brute })
    const before = await lifeOf(s, 'A')

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(brute, 'B')
    await s.setTurn({ phase: 'combat', step: 'combat_damage', active: 'A', priority: 'A' })
    await s.resolveCombat()

    assert.equal(await lifeOf(s, 'A'), before + 6) // 6 damage, 6 life
  })
})

// LT4 (mig 386) — PRINTED lifelink: the catalog `keywords` array alone, no
// script and no grant, must pay the controller on combat damage.
test('LT4 printed lifelink keyword pays the controller', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const cat = await s.spawnCreature('A', 'Lifelink Cat Test') // 2/2, keywords:["Lifelink"]
    const before = await lifeOf(s, 'A')

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(cat, 'B')
    await s.setTurn({ phase: 'combat', step: 'combat_damage', active: 'A', priority: 'A' })
    await s.resolveCombat()

    assert.equal(await lifeOf(s, 'A'), before + 2) // 2 damage, 2 life
  })
})

// LT2 — becomes_tapped: tapping a land for mana fires the card's own trigger
// (Phyrexian Atlas pattern), gated on corrupted.
test('LT2 becomes_tapped fires on a mana tap', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.client.query(
      `update public.game_session_players set counters = jsonb_build_object('poison','3')
       where session_id = $1 and player_id = $2`, [s.sessionId, s.players.B])
    const atlas = await s.spawn('A', 'Phyrexian Atlas Test', 'battlefield')
    const before = await lifeOf(s, 'B')

    await s.as('A').activateMana(atlas, 0, null, 'W') // tap → trigger enqueues
    await s.as('A').resolveStack()

    assert.equal(await lifeOf(s, 'B'), before - 1) // corrupted drain
  })
})

// LT3 — the not_attacking filter: an attack tap does NOT feed Verity Circle,
// a cost tap does.
test('LT3 Verity Circle ignores attack taps', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawn('A', 'Verity Circle Test', 'battlefield')
    await s.spawn('A', 'Wastes Test', 'library')
    const raider = await s.spawnCreature('B', 'Air Elemental Test')
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'B', priority: 'B' })
    await s.as('B').declareAttacker(raider, 'A') // taps as part of attacking

    const none = await s.client.query(
      `select 1 from public.game_stack_items where session_id = $1 and status = 'pending'`,
      [s.sessionId])
    assert.equal(none.rows.length, 0) // no draw trigger for the attack tap

    const tapper = await s.spawnCreature('B', 'Atzocan Seer Test')
    await s.as('B').activateMana(tapper, 0, null, 'G') // a COST tap
    await s.as('A').resolveStack()
    const hand = await s.client.query<{ n: string }>(
      `select count(*)::int as n from public.game_cards
       where session_id = $1 and owner_id = $2 and zone = 'hand'`,
      [s.sessionId, s.players.A])
    assert.equal(Number(hand.rows[0]!.n), 1) // the cost tap drew
  })
})
