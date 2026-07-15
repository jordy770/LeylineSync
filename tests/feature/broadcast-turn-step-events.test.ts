// mig 396 — broadcast turn-step events: beginning_of_each_upkeep and
// beginning_of_each_draw_step fire for EVERY battlefield permanent (any
// controller), mirroring beginning_of_each_end_step (mig 206). Plus draw
// recipient 'active_player' (Kami of the Crescent Moon: "each player's draw
// step, that player draws an additional card").

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function charge(s: Scenario, id: string): Promise<number> {
  const r = await s.client.query(
    `select coalesce((counters ->> 'charge')::int, 0) as n from public.game_cards where id = $1`, [id])
  return r.rows[0].n
}

async function handCount(s: Scenario, seat: 'A' | 'B'): Promise<number> {
  const r = await s.client.query(
    `select count(*)::int as n from public.game_cards
     where session_id = $1 and owner_id = $2 and zone = 'hand'`,
    [s.sessionId, s.players[seat]])
  return r.rows[0].n
}

// BT1 — each-upkeep ticks on the OPPONENT's upkeep too (Midnight Clock shape).
test('BT1 beginning_of_each_upkeep fires on every player\'s upkeep', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const ticker = await s.spawn('A', 'Each Upkeep Ticker Test', 'battlefield')

    await s.setTurn({ phase: 'beginning', step: 'upkeep', active: 'B', priority: 'B' })
    while ((await s.pendingCount()) > 0) await s.as('B').resolveStack()
    assert.equal(await charge(s, ticker), 1)

    // The turn-state trigger fires on step CHANGES; pass through another step
    // (as a real turn does) before the next upkeep.
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'B', priority: 'B' })
    await s.setTurn({ phase: 'beginning', step: 'upkeep', active: 'A', priority: 'A' })
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()
    assert.equal(await charge(s, ticker), 2)
  })
})

// BT2 — each-draw-step + recipient active_player: the TURN player draws the
// extra card, wherever the permanent sits (Kami of the Crescent Moon shape).
test('BT2 each draw step gives the ACTIVE player the extra draw', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Each Draw Gifter Test')
    for (const seat of ['A', 'B'] as const) {
      await s.spawn(seat, 'Goblin Raider Test', 'library')
      await s.spawn(seat, 'Goblin Raider Test', 'library')
    }

    await s.setTurn({ phase: 'beginning', step: 'draw', active: 'B', priority: 'B' })
    while ((await s.pendingCount()) > 0) await s.as('B').resolveStack()
    assert.equal(await handCount(s, 'B'), 1) // B's draw step → B draws
    assert.equal(await handCount(s, 'A'), 0) // the controller does NOT

    // Step change is required for the turn-state trigger; pass through main.
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'B', priority: 'B' })
    await s.setTurn({ phase: 'beginning', step: 'draw', active: 'A', priority: 'A' })
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()
    assert.equal(await handCount(s, 'A'), 1) // A's own draw step → A draws
    assert.equal(await handCount(s, 'B'), 1)
  })
})
