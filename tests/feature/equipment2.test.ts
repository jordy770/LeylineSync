// mig 267 — Equipment phase 2: attached_host watcher (Skullclamp), dynamic
// continuous pump payloads (Cranial Plating / Bonehoard), living weapon.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// EQ2 — Skullclamp: +1/-1 on the host; the host dying draws two. A stranger
// dying draws nothing.
test('EQ2 Skullclamp draws two when its host dies', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    for (let i = 0; i < 3; i++) await s.spawn('A', 'Wastes Test', 'library')
    const clamp = await s.spawn('A', 'Skullclamp Test', 'battlefield')
    const host = await s.spawnCreature('A', 'Dino Grunt Test') // 3/3
    const stranger = await s.spawnCreature('A', 'Air Elemental Test')

    await s.setMana('A', { C: 1 })
    await s.as('A').activate(clamp, 0, { targetCardId: host })
    assert.equal(await s.effectivePower(host), 4) // +1
    assert.equal(await s.effectiveToughness(host), 2) // -1

    await s.putInGraveyard(stranger) // not the host — no trigger
    await s.putInGraveyard(host)
    await s.as('A').resolveStack() // the attached_host draw trigger

    const hand = await s.client.query<{ n: string }>(
      `select count(*)::int as n from public.game_cards
       where session_id = $1 and owner_id = $2 and zone = 'hand'`,
      [s.sessionId, s.players.A])
    assert.equal(Number(hand.rows[0]!.n), 2)
  })
})

// EQ3 — Cranial Plating: +1/+0 per artifact you control, live-updating.
test('EQ3 Cranial Plating tracks the artifact count', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const plating = await s.spawn('A', 'Cranial Plating Test', 'battlefield')
    const host = await s.spawnCreature('A', 'Dino Grunt Test') // 3/3

    await s.setMana('A', { C: 1 })
    await s.as('A').activate(plating, 0, { targetCardId: host })
    assert.equal(await s.effectivePower(host), 4) // 3 + 1 (Plating itself)

    await s.spawn('A', 'Ichor Wellspring Test', 'battlefield')
    await s.as('A').resolveStack() // Wellspring ETB draw (empty library is fine? no - feed it)
    assert.equal(await s.effectivePower(host), 5) // count went up at read time
  })
})

// EQ4 — Bonehoard: living weapon Germ + all-graveyards creature count.
test('EQ4 Bonehoard germs up and counts every graveyard', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const mine = await s.spawnCreature('A', 'Dino Grunt Test')
    const theirs = await s.spawnCreature('B', 'Air Elemental Test')
    await s.putInGraveyard(mine)
    await s.putInGraveyard(theirs) // 2 creature cards across BOTH graveyards

    await s.spawn('A', 'Bonehoard Test', 'battlefield')
    await s.as('A').resolveStack() // living weapon → Germ + attach

    const germ = await s.client.query<{ id: string }>(
      `select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
       where gc.session_id = $1 and gc.zone = 'battlefield' and c.name = 'Germ Token'`,
      [s.sessionId])
    assert.equal(germ.rows.length, 1)
    assert.equal(await s.effectivePower(germ.rows[0]!.id), 2) // 0 + 2
    assert.equal(await s.effectiveToughness(germ.rows[0]!.id), 2)
  })
})
