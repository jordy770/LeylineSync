// mig 394 — draw honors `recipient` (bug-2684): each_opponent / each_player
// draw for those players instead of always the effect's controller.
// Cut a Deal previously drew a card for the CASTER instead of each opponent.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function handCount(s: Scenario, seat: 'A' | 'B'): Promise<number> {
  const r = await s.client.query(
    `select count(*)::int as n from public.game_cards
     where session_id = $1 and owner_id = $2 and zone = 'hand'`,
    [s.sessionId, s.players[seat]])
  return r.rows[0].n
}

async function stockLibraries(s: Scenario): Promise<void> {
  for (const seat of ['A', 'B'] as const) {
    await s.spawn(seat, 'Goblin Raider Test', 'library')
    await s.spawn(seat, 'Goblin Raider Test', 'library')
    await s.spawn(seat, 'Goblin Raider Test', 'library')
  }
}

// RD1 — recipient each_opponent: only the opponent draws.
test('RD1 draw with recipient each_opponent draws for the opponent, not the caster', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await stockLibraries(s)

    await s.as('A').castSpellEffect([{ type: 'draw', recipient: 'each_opponent', amount: 1 }])
    await s.as('A').resolveStack()

    assert.equal(await handCount(s, 'A'), 0)
    assert.equal(await handCount(s, 'B'), 1)
  })
})

// RD2 — recipient each_player: everyone draws.
test('RD2 draw with recipient each_player draws for every player', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await stockLibraries(s)

    await s.as('A').castSpellEffect([{ type: 'draw', recipient: 'each_player', amount: 2 }])
    await s.as('A').resolveStack()

    assert.equal(await handCount(s, 'A'), 2)
    assert.equal(await handCount(s, 'B'), 2)
  })
})

// RD3 — Cut a Deal's program shape: each opponent draws one, then the caster
// draws one per opponent. Default (no recipient) still lands on the controller.
test('RD3 Cut a Deal shape: opponent draws one, caster draws num_opponents', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await stockLibraries(s)

    await s.as('A').castSpellEffect([
      { type: 'draw', recipient: 'each_opponent', amount: 1 },
      { type: 'draw', amount: { count: 'num_opponents' } },
    ])
    await s.as('A').resolveStack()

    assert.equal(await handCount(s, 'A'), 1) // one opponent → caster draws 1
    assert.equal(await handCount(s, 'B'), 1)
  })
})
