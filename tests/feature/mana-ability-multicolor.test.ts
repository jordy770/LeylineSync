// Mana abilities with an activation cost + multiple produced colours (mig 180).
// Dimir Signet: "{1}, {T}: Add {U}{B}" — pays {1}, taps, then adds one blue and
// one black. The net is +1 mana, and it fixes colours.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// DS1 — pay {1} (one generic), tap, add {U}{B}.
test('DS1 Dimir Signet pays {1}, taps, and adds U and B', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const signet = await s.spawn('A', 'Dimir Signet Test', 'battlefield')
    await s.setMana('A', { C: 1 }) // one generic to pay the {1}

    await s.as('A').activateMana(signet, 0)

    const pool = await s.manaOf('A')
    assert.equal(pool.C, 0) // the {1} generic was spent
    assert.equal(pool.U, 1) // produced
    assert.equal(pool.B, 1) // produced
    assert.equal((await s.cardState(signet)).is_tapped, true)
  })
})

// DS2 — without the {1} in the pool, activation fails (and nothing is produced).
test('DS2 Dimir Signet cannot be activated without paying {1}', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const signet = await s.spawn('A', 'Dimir Signet Test', 'battlefield')
    // No mana in pool.

    await client.query('savepoint sp_ds2')
    await assert.rejects(() => s.as('A').activateMana(signet, 0))
    await client.query('rollback to savepoint sp_ds2')

    assert.equal((await s.cardState(signet)).is_tapped, false) // untapped — never paid
    const pool = await s.manaOf('A')
    assert.equal(pool.U ?? 0, 0)
    assert.equal(pool.B ?? 0, 0)
  })
})
