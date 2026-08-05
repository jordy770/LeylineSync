// Bucket-8 slice (mig 441) — mana-ability riders & friends:
// - Mana abilities honor an activation `condition` (Glistening Sphere's
//   corrupted "{T}: Add three ... only if an opponent has 3+ poison").
// - Card-scoped pump statics honor a payload `condition` (Drover of the
//   Mighty: "+2/+2 as long as you control a Dinosaur"), read live by the
//   layered P/T fold.
// - remove_from_combat (Labyrinth of Skophos): a targeted ability that pulls
//   an attacker (or blocker) out of combat.
// - sacrifice_unless_pay (Rupture Spire / Transguild Promenade): the ETB
//   parks a pay-or-sacrifice decision.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

import type { Client } from 'pg'

async function setPoison(client: Client, s: Scenario, seat: 'B', amount: number) {
  await client.query(
    `update public.game_session_players
     set counters = coalesce(counters, '{}'::jsonb) || jsonb_build_object('poison', $3::int)
     where session_id = $1 and player_id = $2`,
    [s.sessionId, s.playerId(seat), amount],
  )
}

// MB1 — the corrupted mana ability is locked without the poison bar...
test('MB1 a conditioned mana ability is refused below the bar', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const sphere = await s.spawn('A', 'Corrupted Sphere Test', 'battlefield')
    await assert.rejects(() => s.as('A').activateMana(sphere, 1, null, 'U'), /cannot be activated/i)
  })
})

// MB1b — ...and opens once an opponent is corrupted.
test('MB1b a conditioned mana ability works once the bar is met', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const sphere = await s.spawn('A', 'Corrupted Sphere Test', 'battlefield')
    await setPoison(client, s, 'B', 3)
    const pool = await s.as('A').activateMana(sphere, 1, null, 'U')
    assert.equal(pool.U, 3)
  })
})

// MB2 — the conditional pump static reads the board live.
test('MB2 a conditional pump static applies only while the condition holds', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const drover = await s.spawn('A', 'Dino Drover Test', 'battlefield') // 1/1

    assert.equal(await s.effectivePower(drover), 1) // no Dinosaur yet
    const dino = await s.spawn('A', 'Dino Grunt Test', 'battlefield')
    assert.equal(await s.effectivePower(drover), 3) // +2/+2 while the Dino lives
    await s.putInGraveyard(dino)
    assert.equal(await s.effectivePower(drover), 1) // condition dropped again
  })
})

// MB3 — remove_from_combat pulls an attacker out of combat.
test('MB3 remove_from_combat clears the attack assignment', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const attacker = await s.spawnCreature('A', 'Goblin Raider Test')
    const maze = await s.spawn('B', 'Skophos Maze Test', 'battlefield')
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(attacker, 'B')
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'B' })
    await s.setMana('B', { C: 4 })

    await s.as('B').activate(maze, 0, { targetCardId: attacker })
    while ((await s.pendingCount()) > 0) await s.as('B').resolveStack()

    const { rows } = await client.query<{ n: string }>(
      'select count(*) as n from public.game_combat_assignments where session_id = $1 and attacker_card_id = $2',
      [s.sessionId, attacker],
    )
    assert.equal(Number(rows[0]?.n), 0)
  })
})

// MB4 — declining the ETB tax sacrifices the land...
test('MB4 sacrifice_unless_pay sacrifices on decline', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spire = await s.spawn('A', 'Spire Land Test', 'battlefield')
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()

    const decision = await s.pendingDecision()
    assert.ok(decision)
    assert.equal(decision.decision_type, 'sacrifice_unless_pay')
    await s.as('A').submitDecision(decision.id, { confirmed: false })
    assert.equal(await s.zoneOf(spire), 'graveyard')
  })
})

// MB4b — ...and paying {1} keeps it.
test('MB4b sacrifice_unless_pay keeps the land when the tax is paid', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { C: 1 })
    const spire = await s.spawn('A', 'Spire Land Test', 'battlefield')
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()

    const decision = await s.pendingDecision()
    assert.ok(decision)
    await s.as('A').submitDecision(decision.id, { confirmed: true })
    assert.equal(await s.zoneOf(spire), 'battlefield')
    assert.deepEqual((await s.manaOf('A')).C ?? 0, 0) // the {1} was consumed
  })
})
