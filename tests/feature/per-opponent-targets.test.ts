// mig 415 — "for each opponent, exile up to one target … that player controls"
// (Bronzebeak Foragers / Grasp of Fate). per_opponent scales the target count to
// the number of living opponents and enforces at most one target per opponent.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function pendingTrigger(s: Scenario): Promise<{ id: string; payload: Record<string, unknown> } | null> {
  const r = await s.client.query<{ id: string; payload: Record<string, unknown> }>(
    `select id, payload from public.game_stack_items
     where session_id = $1 and status = 'pending' and action_type = 'triggered_ability'
     order by position desc limit 1`,
    [s.sessionId])
  return r.rows[0] ?? null
}

// PO1 — three players: the count scales to 2 opponents; one of each is exiled.
test('PO1 exiles one permanent per opponent in a 3-player game', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 3)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bPerm = await s.spawnCreature('B', 'Grave Shambler Test')
    const cPerm = await s.spawnCreature('C', 'Grave Shambler Test')

    await s.spawnCreature('A', 'Foragers Test') // ETB per_opponent trigger
    const trig = await pendingTrigger(s)
    assert.ok(trig)
    assert.equal(trig!.payload.target_count, 2) // two living opponents
    assert.equal(trig!.payload.target_optional, true)

    await s.as('A').chooseTriggerTargets(trig!.id, [bPerm, cPerm])
    await s.as('A').resolveStack()
    assert.equal(await s.zoneOf(bPerm), 'exile')
    assert.equal(await s.zoneOf(cPerm), 'exile')
  })
})

// PO2 — at most one target per opponent: two of the SAME opponent's is rejected.
test('PO2 rejects two targets from the same opponent', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 3)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const b1 = await s.spawnCreature('B', 'Grave Shambler Test')
    const b2 = await s.spawnCreature('B', 'Grave Shambler Test')
    await s.spawnCreature('C', 'Grave Shambler Test') // keeps opponent count at 2

    await s.spawnCreature('A', 'Foragers Test')
    const trig = await pendingTrigger(s)
    await assert.rejects(
      () => s.as('A').chooseTriggerTargets(trig!.id, [b1, b2]) as Promise<unknown>,
      /per opponent/i)
  })
})

// PO3 — two players: the count collapses to a single target (one opponent).
test('PO3 collapses to a single target in a 2-player game', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client) // 2 players
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bPerm = await s.spawnCreature('B', 'Grave Shambler Test')

    await s.spawnCreature('A', 'Foragers Test')
    const trig = await pendingTrigger(s)
    assert.equal(trig!.payload.target_count, 1) // one opponent

    await s.as('A').chooseTriggerTargets(trig!.id, [bPerm])
    await s.as('A').resolveStack()
    assert.equal(await s.zoneOf(bPerm), 'exile')
  })
})
