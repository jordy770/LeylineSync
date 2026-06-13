// mig 284 — chosen cost payments: p_cost_card_ids lets the activator pick
// exactly which cards pay sacrifice_artifacts / return_land / tap_creatures.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// CP1 — Breya's sac-two: the player keeps her Thopters and feeds two
// EXPENSIVE artifacts instead of the auto-pick cheapest.
test('CP1 chosen artifacts pay the cost, tokens survive', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const breya = await s.spawnCreature('A', 'Breya Shaper Test')
    await s.as('A').resolveStack() // two Thopters
    const r1 = await s.spawn('A', 'Ichor Wellspring Test', 'battlefield')
    const r2 = await s.spawn('A', 'Skullclamp Test', 'battlefield')
    await s.as('A').resolveStack() // flush the Wellspring draw

    await s.setMana('A', { C: 2 })
    await s.as('A').activate(breya, 0, { costCardIds: [r1, r2] })
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { chosen: [2] }) // gain 5

    const thopters = await s.client.query<{ n: string }>(
      `select count(*)::int as n from public.game_cards gc join public.cards c on c.id = gc.card_id
       where gc.session_id = $1 and gc.zone = 'battlefield' and c.name = 'Thopter Token'`,
      [s.sessionId])
    assert.equal(Number(thopters.rows[0]!.n), 2) // tokens kept
    for (const id of [r1, r2]) {
      const z = await s.client.query<{ zone: string }>(
        'select zone from public.game_cards where id = $1', [id])
      assert.equal(z.rows[0]!.zone, 'graveyard') // the chosen ones paid
    }
  })
})

// CP2 — an illegal pick (opponent's artifact) fails the whole activation.
test('CP2 illegal cost pick is rejected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const breya = await s.spawnCreature('A', 'Breya Shaper Test')
    await s.as('A').resolveStack()
    const theirs = await s.spawn('B', 'Ichor Wellspring Test', 'battlefield')
    await s.as('B').resolveStack()
    await s.setMana('A', { C: 2 })

    await assert.rejects(
      () => s.as('A').activate(breya, 0, { costCardIds: [theirs, theirs] }),
      /not a legal artifact/)
  })
})
