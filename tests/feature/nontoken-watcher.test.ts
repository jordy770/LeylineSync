// `nontoken` watcher filter (mig 181) — "Whenever a NONTOKEN creature you control
// dies, …" (Midnight Reaper, Open the Graves). The watcher fires when a nontoken
// creature dies but ignores token creatures.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function pending(s: Scenario): Promise<number> {
  const r = await s.client.query<{ n: string }>(
    "select count(*) as n from public.game_stack_items where session_id = $1 and status <> 'resolved'",
    [s.sessionId],
  )
  return Number(r.rows[0]!.n)
}

// NT1 — a NONTOKEN creature dying triggers Midnight Reaper (draw + lose 1 life).
test('NT1 nontoken death triggers the watcher', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Midnight Reaper Test')
    const victim = await s.spawnCreature('A', 'Grave Shambler Test') // nontoken Zombie
    await s.spawn('A', 'Air Elemental Test', 'library')
    const handBefore = await s.zoneCount('A', 'hand')
    const lifeBefore = await s.lifeOf('A')

    await s.as('A').putOnStack('destroy_creature', { target_card_id: victim, target_controller: 'any' })
    await s.as('A').resolveStack() // destroy → death broadcast
    await s.as('A').resolveStack() // draw + lose_life resolves

    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 1)
    assert.equal(await s.lifeOf('A'), lifeBefore - 1)
  })
})

// NT2 — a TOKEN creature dying does NOT trigger (nontoken filter).
test('NT2 token death does not trigger the watcher', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Midnight Reaper Test')
    const token = await s.spawn('A', 'Zombie Token', 'battlefield') // a token creature
    await s.spawn('A', 'Air Elemental Test', 'library')
    const handBefore = await s.zoneCount('A', 'hand')

    await s.as('A').putOnStack('destroy_creature', { target_card_id: token, target_controller: 'any' })
    await s.as('A').resolveStack() // destroys the token

    assert.equal(await pending(s), 0) // no trigger enqueued
    assert.equal(await s.zoneCount('A', 'hand'), handBefore) // did not draw
  })
})
