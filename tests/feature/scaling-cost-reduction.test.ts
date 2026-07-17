// mig 416 — count-scaled self cost reduction: cost_reduction {amount, per:{count}}
// shaves amount × count generic mana at cast. Blasphemous Act ("{1} less for each
// creature on the battlefield"), Coastal Breach / Undaunted ("{1} less per
// opponent"). Each test funds EXACTLY the reduced cost, so a successful cast
// proves the reduction (an unreduced cast would be short on mana).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function pool(s: Scenario, seat: 'A' | 'B' | 'C'): Promise<Record<string, number>> {
  const r = await s.client.query<{ mana_pool: Record<string, number> }>(
    `select mana_pool from public.game_players where session_id = $1 and player_id = $2`,
    [s.sessionId, s.players[seat]])
  return r.rows[0]?.mana_pool ?? {}
}

// SCR1 — {5} spell with three creatures on the battlefield casts for {2}.
test('SCR1 reduces {1} per creature on the battlefield', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    for (let i = 0; i < 2; i++) await s.spawnCreature('A', 'Air Elemental Test')
    await s.spawnCreature('B', 'Air Elemental Test') // 3 creatures total, any controller
    const spell = await s.spawn('A', 'Scaling Spell Test', 'hand') // {5}

    await s.setMana('A', { C: 2 }) // {5} − 3 = {2}
    await s.as('A').castSpellEffect([{ type: 'draw', amount: 1 }], spell)
    await s.as('A').resolveStack()
    assert.deepEqual(await pool(s, 'A'), { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 })
  })
})

// SCR2 — Undaunted: {5} spell in a 3-player game (2 opponents) casts for {3}.
test('SCR2 reduces {1} per opponent (Undaunted)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 3)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Undaunted Spell Test', 'hand') // {5}

    await s.setMana('A', { C: 3 }) // {5} − 2 opponents = {3}
    await s.as('A').castSpellEffect([{ type: 'draw', amount: 1 }], spell)
    await s.as('A').resolveStack()
    assert.deepEqual(await pool(s, 'A'), { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 })
  })
})

// SCR3 — the reduction floors at zero: a {2} spell with 3 creatures costs {0},
// not negative (it does not refund mana).
test('SCR3 scaled reduction floors the generic cost at zero', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    for (let i = 0; i < 3; i++) await s.spawnCreature('A', 'Air Elemental Test') // 3 creatures
    const spell = await s.spawn('A', 'Cheap Scaling Test', 'hand') // {2}

    await s.setMana('A', { C: 0 }) // {2} − 3 → floored to {0}
    await s.as('A').castSpellEffect([{ type: 'draw', amount: 1 }], spell)
    await s.as('A').resolveStack()
    assert.deepEqual(await pool(s, 'A'), { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 })
  })
})
