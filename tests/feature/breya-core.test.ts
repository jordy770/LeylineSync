// mig 264 — Breya core. Engine touch: 'sacrifice_artifacts' activation cost
// (auto-picks the cheapest-MV artifacts you control, source excluded —
// tokens are MV 0 so they go first). Breya, Thopter Foundry; Etherium
// Sculptor and the Wellsprings are script-only.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// BC1 — Breya: ETB makes two Thopters; the sac ability eats them and gains 5.
test('BC1 Breya tokens then sac-two for life', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const breya = await s.spawnCreature('A', 'Breya Shaper Test')
    await s.as('A').resolveStack() // ETB → two Thopters

    const thopters = await s.client.query<{ n: string }>(
      `select count(*)::int as n from public.game_cards gc join public.cards c on c.id = gc.card_id
       where gc.session_id = $1 and gc.zone = 'battlefield' and c.name = 'Thopter Token'`,
      [s.sessionId])
    assert.equal(Number(thopters.rows[0]!.n), 2)

    await s.setMana('A', { C: 2 })
    const before = await s.client.query<{ life_total: number }>(
      'select life_total from public.game_session_players where session_id = $1 and player_id = $2',
      [s.sessionId, s.players.A])
    await s.as('A').activate(breya, 0)
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'choose_mode')
    await s.as('A').submitDecision(d!.id, { chosen: [2] }) // gain 5 life

    const after = await s.client.query<{ life_total: number }>(
      'select life_total from public.game_session_players where session_id = $1 and player_id = $2',
      [s.sessionId, s.players.A])
    assert.equal(after.rows[0]!.life_total, before.rows[0]!.life_total + 5)
    const left = await s.client.query<{ n: string }>(
      `select count(*)::int as n from public.game_cards gc join public.cards c on c.id = gc.card_id
       where gc.session_id = $1 and gc.zone = 'battlefield' and c.name = 'Thopter Token'`,
      [s.sessionId])
    assert.equal(Number(left.rows[0]!.n), 0) // both Thopters paid the cost
  })
})

// BC2 — Thopter Foundry: needs a NONTOKEN artifact; sacs it, makes a Thopter,
// gains 1 life.
test('BC2 Thopter Foundry sacs a nontoken artifact', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Wastes Test', 'library') // feeds the Wellspring ETB draw
    const foundry = await s.spawn('A', 'Thopter Foundry Test', 'battlefield')
    const fodder = await s.spawn('A', 'Ichor Wellspring Test', 'battlefield')
    await s.as('A').resolveStack() // the Wellspring ETB draw

    await s.setMana('A', { C: 1 })
    await s.as('A').activate(foundry, 0)
    await s.as('A').resolveStack()

    const dead = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [fodder])
    assert.equal(dead.rows[0]!.zone, 'graveyard')
    const thopter = await s.client.query<{ n: string }>(
      `select count(*)::int as n from public.game_cards gc join public.cards c on c.id = gc.card_id
       where gc.session_id = $1 and gc.zone = 'battlefield' and c.name = 'Thopter Token'`,
      [s.sessionId])
    assert.equal(Number(thopter.rows[0]!.n), 1)
  })
})

// BC3 — Ichor Wellspring draws on entry AND on dying.
test('BC3 Ichor Wellspring draws twice across its life', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    for (let i = 0; i < 2; i++) await s.spawn('A', 'Wastes Test', 'library')

    const well = await s.spawn('A', 'Ichor Wellspring Test', 'battlefield')
    await s.as('A').resolveStack() // ETB draw
    await s.putInGraveyard(well)
    await s.as('A').resolveStack() // dies draw

    const hand = await s.client.query<{ n: string }>(
      `select count(*)::int as n from public.game_cards
       where session_id = $1 and owner_id = $2 and zone = 'hand'`,
      [s.sessionId, s.players.A])
    assert.equal(Number(hand.rows[0]!.n), 2)
  })
})
