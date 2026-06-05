// Phase 4 / F1 — APNAP ordering of simultaneous triggered abilities (mig 123).
// When one event fires triggers controlled by several players, they go on the
// stack in active-player-first order, so the active player's resolve LAST (the
// stack is LIFO: lowest position resolves last). order_pending_triggers settles
// the batch regardless of the arbitrary order in which the triggers were enqueued.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// Controllers in resolution order (stack reads top-first = position desc).
async function resolveOrder(s: Scenario): Promise<string[]> {
  const stack = await s.pendingStack()
  return stack.map((i) => String(i.payload.controller_player_id))
}

// AP1 — three players, dies triggers fired in a deliberately non-APNAP order;
// the settle reorders them so the active player's resolves last.
test('AP1 simultaneous triggers settle into APNAP order (3 players)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 3)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const a = await s.spawnCreature('A', 'Parting Gift Test') // dies -> gain 2
    const b = await s.spawnCreature('B', 'Parting Gift Test')
    const c = await s.spawnCreature('C', 'Parting Gift Test')

    // Fire in a non-APNAP order on purpose (B, then C, then A).
    await s.fireTriggers('B', b, ['dies'])
    await s.fireTriggers('C', c, ['dies'])
    await s.fireTriggers('A', a, ['dies'])

    await s.orderTriggers()

    // Resolve order (top-first): most-non-active first, active (A) last.
    assert.deepEqual(await resolveOrder(s), [s.playerId('C'), s.playerId('B'), s.playerId('A')])
  })
})

// AP2 — two players: the active player's trigger resolves after the opponent's,
// regardless of which fired first.
test('AP2 active player resolves last (2 players)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const a = await s.spawnCreature('A', 'Parting Gift Test')
    const b = await s.spawnCreature('B', 'Parting Gift Test')

    await s.fireTriggers('A', a, ['dies']) // active fires first…
    await s.fireTriggers('B', b, ['dies'])
    await s.orderTriggers()

    // …but resolves last: B on top, A below.
    assert.deepEqual(await resolveOrder(s), [s.playerId('B'), s.playerId('A')])
  })
})

// AP3 — settle resolves through correctly: resolving the full stack drains it in
// APNAP order and every controller's dies trigger fires (each gains 2 life).
test('AP3 the settled batch resolves end-to-end', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 3)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const startA = await s.lifeOf('A')
    const startB = await s.lifeOf('B')
    const startC = await s.lifeOf('C')

    const a = await s.spawnCreature('A', 'Parting Gift Test')
    const b = await s.spawnCreature('B', 'Parting Gift Test')
    const c = await s.spawnCreature('C', 'Parting Gift Test')
    await s.fireTriggers('A', a, ['dies'])
    await s.fireTriggers('B', b, ['dies'])
    await s.fireTriggers('C', c, ['dies'])

    // resolve_top_of_stack settles APNAP itself; drain all three.
    await s.as('A').resolveStack()
    await s.as('A').resolveStack()
    await s.as('A').resolveStack()

    assert.equal(await s.lifeOf('A'), startA + 2)
    assert.equal(await s.lifeOf('B'), startB + 2)
    assert.equal(await s.lifeOf('C'), startC + 2)
  })
})
