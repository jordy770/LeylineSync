// mig 253 — discover + Pantlaza, Sun-Favored (the Veloci-Ramp-Tor commander).
//   • discover X: exile from the top until a NONLAND with mana value <= X
//     (lands and oversized nonlands go to the bottom in a random order); the
//     hit may be cast free (permanent -> battlefield) or put into hand.
//   • Pantlaza: any Dinosaur you control entering (itself included) discovers
//     for that creature's mana value — only once each turn (a watcher
//     once_per_turn stamp).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// DS1 — Pantlaza (MV 4) enters: a land and an MV-6 card are skipped to the
// bottom; the MV-4 hit parks the free-cast pick and enters the battlefield.
test('DS1 Pantlaza discovers past lands and oversized cards', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Wastes Test', 'library') // land — skipped
    const big = await s.spawn('A', 'Hammerhead Tyrant Test', 'library') // MV 6 — over X
    const hit = await s.spawn('A', 'Leyline Tyrant Test', 'library') // MV 4 — the discover

    await s.spawnCreature('A', 'Pantlaza, Sun-Favored Test') // Dinosaur, MV 4
    await s.as('A').resolveStack() // its own entry fires the watcher

    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'cast_exiled_free')
    await s.as('A').submitDecision(d!.id, { chosen: [hit] })

    const h = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [hit])
    assert.equal(h.rows[0]!.zone, 'battlefield')
    const b = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [big])
    assert.equal(b.rows[0]!.zone, 'library') // bottomed, not exiled
    const lib = await s.client.query<{ n: string }>(
      `select count(*)::int as n from public.game_cards
       where session_id = $1 and owner_id = $2 and zone = 'library'`,
      [s.sessionId, s.players.A])
    assert.equal(Number(lib.rows[0]!.n), 2) // the land + the oversized card
  })
})

// DS2 — only once each turn: a second Dinosaur entering the same turn does
// not trigger Pantlaza again.
test('DS2 Pantlaza triggers only once each turn', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Leyline Tyrant Test', 'library')
    await s.spawn('A', 'Rapacious Dragon Test', 'library')

    await s.spawnCreature('A', 'Pantlaza, Sun-Favored Test')
    await s.as('A').resolveStack() // first discover
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { chosen: [] }) // to hand

    await s.spawnCreature('A', 'Dino Grunt Test') // a second Dinosaur
    const pending = await s.client.query<{ n: string }>(
      `select count(*)::int as n from public.game_stack_items
       where session_id = $1 and status = 'pending'`,
      [s.sessionId])
    assert.equal(Number(pending.rows[0]!.n), 0) // no second trigger
  })
})
