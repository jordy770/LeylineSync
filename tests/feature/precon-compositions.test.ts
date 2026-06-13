// Precon cards that compose entirely from existing primitives (no new engine):
//   Murder            — destroy target creature
//   Mire Triton       — deathtouch + ETB (mill 2, gain 2)
//   Open the Graves   — nontoken creature you control dies → create a Zombie

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx, asPlayer } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function zombieTokens(s: Scenario, seat: 'A' | 'B'): Promise<number> {
  const r = await s.client.query<{ n: string }>(
    `select count(*) as n from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.controller_player_id = $2 and gc.zone = 'battlefield' and c.name = 'Zombie Token'`,
    [s.sessionId, s.players[seat]],
  )
  return Number(r.rows[0]?.n ?? 0)
}

// MU1 — Murder destroys the targeted creature.
test('MU1 Murder destroys target creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const victim = await s.spawnCreature('B', 'Air Elemental Test')
    const murder = await s.spawn('A', 'Murder Test', 'hand')
    await s.setMana('A', { C: 1, B: 2 }) // {1}{B}{B}

    await s.as('A').castSpellEffect([{ type: 'destroy', target_type: 'creature' }], murder, null, victim)
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(victim), 'graveyard')
  })
})

// MT1 — Mire Triton's ETB mills 2 and gains 2; it has deathtouch.
test('MT1 Mire Triton mills 2, gains 2, and has deathtouch', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Air Elemental Test', 'library')
    await s.spawn('A', 'Deathtouch Viper Test', 'library')
    const lifeBefore = await s.lifeOf('A')
    const gyBefore = await s.zoneCount('A', 'graveyard')

    const triton = await s.spawnCreature('A', 'Mire Triton Test')
    await s.as('A').resolveStack()

    assert.equal(await s.zoneCount('A', 'graveyard'), gyBefore + 2) // milled 2
    assert.equal(await s.lifeOf('A'), lifeBefore + 2) // gained 2
    const dt = await asPlayer(s.client, s.players.A, async () =>
      (await s.client.query<{ r: boolean }>('select public.card_has_deathtouch($1,$2) as r', [s.sessionId, triton])).rows[0]!.r)
    assert.equal(dt, true) // deathtouch
  })
})

// OG1 — a nontoken creature you control dying makes a Zombie; OG2 — a token dying does not.
test('OG1 Open the Graves makes a Zombie when your nontoken creature dies', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Open the Graves Test', 'battlefield')
    const mine = await s.spawnCreature('A', 'Grave Shambler Test') // nontoken
    const before = await zombieTokens(s, 'A')

    await s.as('A').putOnStack('destroy_creature', { target_card_id: mine, target_controller: 'any' })
    await s.as('A').resolveStack() // dies → trigger
    await s.as('A').resolveStack() // create_token resolves

    assert.equal(await zombieTokens(s, 'A'), before + 1)
  })
})

test('OG2 a token creature dying does not trigger Open the Graves', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Open the Graves Test', 'battlefield')
    const tok = await s.spawnCreature('A', 'Zombie Token') // a token
    const before = await zombieTokens(s, 'A')

    await s.as('A').putOnStack('destroy_creature', { target_card_id: tok, target_controller: 'any' })
    await s.as('A').resolveStack()

    assert.equal(await zombieTokens(s, 'A'), before - 1) // the token died; no new token made
  })
})
