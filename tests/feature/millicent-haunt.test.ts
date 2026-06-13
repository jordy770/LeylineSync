// mig 280 — watcher max_power filter: Mentor of the Meek draws only for
// small creatures.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// MH1 — a 1/1 entering draws; a 5/5 entering does not.
test('MH1 Mentor of the Meek max_power gate', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    for (let i = 0; i < 2; i++) await s.spawn('A', 'Wastes Test', 'library')
    await s.spawnCreature('A', 'Mentor Meek Test')

    await s.spawnCreature('A', 'Myr Retriever Test') // 1/1 — draws
    await s.as('A').resolveStack()
    await s.spawnCreature('A', 'Rampaging Brontodon Test') // 7/6 — silent

    const hand = await s.client.query<{ n: string }>(
      `select count(*)::int as n from public.game_cards
       where session_id = $1 and owner_id = $2 and zone = 'hand'`,
      [s.sessionId, s.players.A])
    assert.equal(Number(hand.rows[0]!.n), 1) // exactly one draw
  })
})
