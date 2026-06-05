// Phase 4 — richer mana: HYBRID and PHYREXIAN symbols (mig 121). pay_mana_cost
// now parses {W/U} (either colour), {2/W} (2 generic or 1 white), and {W/P}
// (1 white or 2 life), auto-resolving each symbol unless an explicit per-symbol
// choice is passed. These call pay_mana_cost directly via the harness (no card
// needed) — the cost-parsing/payment layer is what changed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'

// HM1 — two-colour hybrid {W/U}: auto pays whichever colour is available.
test('HM1 two-colour hybrid auto-pays an available colour', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)

    await s.setMana('A', { W: 1 })
    let pool = await s.payMana('A', '{W/U}')
    assert.equal(pool.W, 0)

    // Only U available → auto picks U.
    await s.setMana('A', { U: 1 })
    pool = await s.payMana('A', '{W/U}')
    assert.equal(pool.U, 0)
  })
})

// HM2 — two-colour hybrid honours an explicit choice.
test('HM2 two-colour hybrid pays the explicitly chosen colour', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setMana('A', { W: 1, U: 1 })
    const pool = await s.payMana('A', '{W/U}', { hybrid: ['U'] })
    assert.equal(pool.U, 0)
    assert.equal(pool.W, 1) // untouched
  })
})

// HM3 — monocoloured hybrid {2/W}: colour by default, generic when chosen / forced.
test('HM3 monohybrid pays the colour by default, generic on demand', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)

    // Default: 1 white when white is available.
    await s.setMana('A', { W: 1, R: 2 })
    let pool = await s.payMana('A', '{2/W}')
    assert.equal(pool.W, 0)
    assert.equal(pool.R, 2) // generic side untouched

    // No white → auto falls back to 2 generic (from R).
    await s.setMana('A', { R: 2 })
    pool = await s.payMana('A', '{2/W}')
    assert.equal(pool.R, 0)

    // Explicit GENERIC even with white available. Colourless covers the 2 generic
    // (auto-generic spends C before W), so the white is left untouched.
    await s.setMana('A', { W: 1, C: 2 })
    pool = await s.payMana('A', '{2/W}', { hybrid: ['GENERIC'] })
    assert.equal(pool.W, 1)
    assert.equal(pool.C, 0)
  })
})

// HM4 — Phyrexian {W/P}: colour by default; 2 life when no mana or when chosen.
test('HM4 Phyrexian pays mana by default and life on demand', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const startLife = await s.lifeOf('A')

    // Default: pay the white, life untouched.
    await s.setMana('A', { W: 1 })
    let pool = await s.payMana('A', '{W/P}')
    assert.equal(pool.W, 0)
    assert.equal(await s.lifeOf('A'), startLife)

    // No mana → auto pays 2 life.
    await s.setMana('A', {})
    pool = await s.payMana('A', '{W/P}')
    assert.equal(await s.lifeOf('A'), startLife - 2)

    // Explicit LIFE even with white available.
    await s.setMana('A', { W: 1 })
    pool = await s.payMana('A', '{W/P}', { hybrid: ['LIFE'] })
    assert.equal(pool.W, 1)
    assert.equal(await s.lifeOf('A'), startLife - 4)
  })
})

// HM5 — mixed cost: hybrid symbol alongside plain generic + colour (regression that
// the new tokenizer still handles ordinary symbols).
test('HM5 mixed cost {1}{W/U}{R} parses all symbol kinds', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setMana('A', { W: 1, R: 1, C: 1 })
    const pool = await s.payMana('A', '{1}{W/U}{R}')
    assert.equal(pool.W, 0) // hybrid auto-picked W
    assert.equal(pool.R, 0) // colour
    assert.equal(pool.C, 0) // generic {1}
  })
})

// HM6 — insufficient resources raise (rejection is the last action; no post-query,
// so the rolled-back tx is never read after it aborts — see bug-236).
test('HM6 Phyrexian with no mana and too little life is rejected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setMana('A', {})
    // A cost demanding more life than the player has: each {W/P} auto-pays 2 life
    // (no mana), so (life/2)+1 symbols always exceeds the life total.
    const symbols = Math.floor((await s.lifeOf('A')) / 2) + 1
    await assert.rejects(() => s.payMana('A', '{W/P}'.repeat(symbols)))
  })
})
