// mig 390 — two new resolve_count_amount counts (Prosper precon):
// 'opponent_artifacts_and_enchantments' (Dockside Extortionist's ETB Treasure
// count) and 'creatures_on_battlefield' (Chain Reaction's dynamic X on
// deal_damage_all).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function treasures(s: Scenario, seat: 'A' | 'B'): Promise<number> {
  const r = await s.client.query(
    `select count(*)::int as n from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.controller_player_id = $2 and gc.zone = 'battlefield' and c.name = 'Treasure Token'`,
    [s.sessionId, s.players[seat]])
  return r.rows[0].n
}

// DC1 — Dockside: one Treasure per artifact/enchantment OPPONENTS control;
// own artifacts don't count.
test('DC1 Dockside mints Treasures for opponent artifacts only', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('B', 'Ichor Wellspring Test', 'battlefield') // opponent artifact
    await s.spawn('B', 'Ichor Wellspring Test', 'battlefield') // opponent artifact
    await s.spawn('A', 'Ichor Wellspring Test', 'battlefield') // OWN artifact — must not count

    await s.spawnCreature('A', 'Dockside Extortionist Test')
    // Flush the WHOLE stack: three Wellspring draw triggers + Dockside's ETB.
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()

    assert.equal(await treasures(s, 'A'), 2)
  })
})

// DC2 — Dockside with an empty opposing board makes zero Treasures.
test('DC2 Dockside with nothing to extort mints nothing', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Dockside Extortionist Test')
    await s.as('A').resolveStack()
    assert.equal(await treasures(s, 'A'), 0)
  })
})

// CR1 — Chain Reaction: X = ALL creatures (both players). With 3 creatures the
// 2/2s die to 3 damage while the 4/4 survives — proving X is exactly the board
// count (an inflated X would kill the 4/4 too).
test('CR1 Chain Reaction scales with every creature on the battlefield', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const a1 = await s.spawnCreature('A', 'Goblin Raider Test') // 2/2
    const b1 = await s.spawnCreature('B', 'Air Elemental Test') // 4/4
    const b2 = await s.spawnCreature('B', 'Grave Shambler Test') // 2/2

    await s.as('A').castSpellEffect([
      { type: 'deal_damage_all', amount: { count: 'creatures_on_battlefield' } },
    ])
    await s.as('A').resolveStack()

    // X was 3: both 2/2s die, the 4/4 takes 3 and lives.
    assert.equal(await s.zoneOf(a1), 'graveyard')
    assert.equal(await s.zoneOf(b2), 'graveyard')
    assert.equal(await s.zoneOf(b1), 'battlefield')
  })
})
