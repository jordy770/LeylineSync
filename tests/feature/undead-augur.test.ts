// Undead Augur — "Whenever a Zombie you control dies, you draw a card and you
// lose 1 life." A typed (Zombie) + controller (you) watcher-death payoff, same
// [draw, lose_life] shape as Midnight Reaper but gated by type_line instead of
// `nontoken`. Confirms the typed filter both fires (your Zombie) and ignores a
// non-Zombie of yours.

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

// UA1 — your Zombie dying triggers the augur (draw a card + lose 1 life).
test('UA1 your Zombie dying draws a card and loses 1 life', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Undead Augur Test')
    const zombie = await s.spawnCreature('A', 'Grave Shambler Test') // a Zombie you control
    await s.spawn('A', 'Air Elemental Test', 'library') // something to draw
    const handBefore = await s.zoneCount('A', 'hand')
    const lifeBefore = await s.lifeOf('A')

    await s.as('A').putOnStack('destroy_creature', { target_card_id: zombie, target_controller: 'any' })
    await s.as('A').resolveStack() // destroy → death broadcast
    await s.as('A').resolveStack() // draw + lose_life resolves

    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 1)
    assert.equal(await s.lifeOf('A'), lifeBefore - 1)
  })
})

// UA2 — a NON-Zombie creature you control dying does NOT trigger (type filter).
test('UA2 a non-Zombie death does not trigger the augur', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Undead Augur Test')
    const elemental = await s.spawnCreature('A', 'Air Elemental Test') // not a Zombie
    await s.spawn('A', 'Grave Shambler Test', 'library')
    const handBefore = await s.zoneCount('A', 'hand')
    const lifeBefore = await s.lifeOf('A')

    await s.as('A').putOnStack('destroy_creature', { target_card_id: elemental, target_controller: 'any' })
    await s.as('A').resolveStack() // destroys the elemental

    assert.equal(await pending(s), 0) // no trigger enqueued
    assert.equal(await s.zoneCount('A', 'hand'), handBefore) // did not draw
    assert.equal(await s.lifeOf('A'), lifeBefore) // did not lose life
  })
})
