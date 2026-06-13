// Gravespawn Sovereign (mig 212) — "Tap five untapped Zombies you control: Put
// target creature card from a graveyard onto the battlefield under your
// control." New tap_creatures activation cost (engine auto-picks the five) +
// the reanimate_from_graveyard targeted stack action (mig 186 pattern).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// GS1 — taps five Zombies and steals a creature card from B's graveyard.
test('GS1 tap five Zombies, reanimate from any graveyard under your control', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const sovereign = await s.spawnCreature('A', 'Gravespawn Sovereign Test')
    const zombies: string[] = [sovereign]
    for (let i = 0; i < 4; i++) zombies.push(await s.spawnCreature('A', 'Grave Shambler Test'))
    const goblin = await s.spawnCreature('A', 'Goblin Raider Test') // not a Zombie — untouched
    const dead = await s.spawn('B', 'Goblin Raider Test', 'graveyard') // B's dead creature

    await s.as('A').activate(sovereign, 0, { targetCardId: dead })
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(dead), 'battlefield')
    const ctrl = await s.client.query<{ c: string }>(
      'select controller_player_id as c from public.game_cards where id = $1', [dead])
    assert.equal(ctrl.rows[0]!.c, s.playerId('A')) // under YOUR control

    const tapped = await s.client.query<{ n: string }>(
      `select count(*) as n from public.game_cards where session_id = $1 and is_tapped = true`,
      [s.sessionId],
    )
    assert.equal(Number(tapped.rows[0]!.n), 5) // exactly the five Zombies
    const goblinRow = await s.client.query<{ t: boolean }>(
      'select is_tapped as t from public.game_cards where id = $1', [goblin])
    assert.equal(goblinRow.rows[0]!.t, false)
  })
})

// GS2 — fewer than five untapped Zombies: the activation is refused.
test('GS2 not enough untapped Zombies', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const sovereign = await s.spawnCreature('A', 'Gravespawn Sovereign Test')
    await s.spawnCreature('A', 'Grave Shambler Test') // only 2 Zombies total
    const dead = await s.spawn('B', 'Goblin Raider Test', 'graveyard')

    await assert.rejects(
      () => s.as('A').activate(sovereign, 0, { targetCardId: dead }),
      /untapped zombie/i,
    )
  })
})
