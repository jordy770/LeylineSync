// Eldrazi Scion/Spawn tokens (Sifter of Skulls / Pawn of Ulamog, Meren precon):
// "Sacrifice this token: Add {C}." — a sacrifice-ONLY mana ability (no tap cost;
// Treasure's mig 226 path with v_has_tap = false).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

test('ES1 an Eldrazi Scion cracks for {C} without tapping and is sacrificed', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const scion = await s.spawn('A', 'Eldrazi Scion Token', 'battlefield')

    const pool = await s.as('A').activateMana(scion, 0, null, null)
    assert.equal(pool.C, 1)

    // Sacrificed → off the battlefield (token ceases to exist).
    const r = await s.client.query(
      `select 1 from public.game_cards where id = $1 and zone = 'battlefield'`, [scion])
    assert.equal(r.rowCount, 0)
  })
})
