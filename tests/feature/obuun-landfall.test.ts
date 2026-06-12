// mig 276 — Obuun landfall: Sun Titan's MV-capped graveyard return.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// OB1 — Sun Titan offers only MV<=3 cards and returns the pick to play.
test('OB1 Sun Titan returns a cheap permanent', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const cheap = await s.spawn('A', 'Ichor Wellspring Test', 'graveyard') // MV 2
    await s.spawn('A', 'Earthshaker Dreadmaw Test', 'graveyard') // MV 6 — filtered out

    await s.spawnCreature('A', 'Sun Titan Test')
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'return_from_graveyard')
    const offered = (d!.options as Array<{ name: string }>).map((o) => o.name)
    assert.ok(offered.includes('Ichor Wellspring Test'))
    assert.ok(!offered.includes('Earthshaker Dreadmaw Test')) // MV 6 > 3
    await s.as('A').submitDecision(d!.id, { chosen: [cheap] })

    const row = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [cheap])
    assert.equal(row.rows[0]!.zone, 'battlefield')
  })
})
