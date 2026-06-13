// mig 281 — Millicent finale: Promise of Bunrei pays out once then
// sacrifices itself; Fell the Mighty wipes only the big creatures.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// MF1 — Bunrei: a creature dying makes four Spirits and consumes the
// enchantment (no second payout).
test('MF1 Promise of Bunrei one-shot payout', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const promise = await s.spawn('A', 'Promise Bunrei Test', 'battlefield')
    const fodder = await s.spawnCreature('A', 'Dino Grunt Test')

    await s.putInGraveyard(fodder)
    await s.as('A').resolveStack()

    const spirits = await s.client.query<{ n: string }>(
      `select count(*)::int as n from public.game_cards gc join public.cards c on c.id = gc.card_id
       where gc.session_id = $1 and gc.zone = 'battlefield' and c.name = 'Spirit Token'`,
      [s.sessionId])
    assert.equal(Number(spirits.rows[0]!.n), 4)
    const gone = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [promise])
    assert.equal(gone.rows[0]!.zone, 'graveyard') // sacrificed itself
  })
})

// MF2 — Fell the Mighty: power >= 4 dies, the small survive.
test('MF2 Fell the Mighty spares the meek', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const small = await s.spawnCreature('A', 'Dino Grunt Test') // 3/3
    const big = await s.spawnCreature('B', 'Rampaging Brontodon Test') // 7/6

    await s.as('A').castSpellEffect([{ type: 'destroy_all', min_power: 4 }])
    await s.as('A').resolveStack()

    const rows = await s.client.query<{ id: string; zone: string }>(
      'select id, zone from public.game_cards where id = any($1::uuid[])', [[small, big]])
    const byId = new Map(rows.rows.map((r) => [r.id, r.zone]))
    assert.equal(byId.get(small), 'battlefield')
    assert.equal(byId.get(big), 'graveyard')
  })
})
