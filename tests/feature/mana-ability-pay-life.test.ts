// `pay_life` as a mana-ability cost (mig 189). Talisman of Dominance: "{T}: Add
// {C}. {T}, Pay 1 life: Add {U} or {B}." — modelled as three single-colour {T}
// mana abilities (C free; U / B each cost 1 life), since the one {T} means only
// one can be used per untap.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// TD1 — the free {C} ability (index 0): taps, adds {C}, costs no life.
test('TD1 the colorless ability adds {C} and pays no life', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const talisman = await s.spawn('A', 'Talisman of Dominance Test', 'battlefield')
    const lifeBefore = await s.lifeOf('A')

    await s.as('A').activateMana(talisman, 0)

    assert.equal((await s.manaOf('A')).C, 1)
    assert.equal(await s.lifeOf('A'), lifeBefore) // no life paid
    assert.equal((await s.cardState(talisman)).is_tapped, true)
  })
})

// TD2 — the {U} ability (index 1): taps, adds {U}, pays 1 life.
test('TD2 the blue ability adds {U} and pays 1 life', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const talisman = await s.spawn('A', 'Talisman of Dominance Test', 'battlefield')
    const lifeBefore = await s.lifeOf('A')

    await s.as('A').activateMana(talisman, 1)

    assert.equal((await s.manaOf('A')).U, 1)
    assert.equal(await s.lifeOf('A'), lifeBefore - 1) // 1 life paid
    assert.equal((await s.cardState(talisman)).is_tapped, true)
  })
})

// TD3 — a player with no life left can't pay the life cost.
test('TD3 the pay-life ability is rejected with insufficient life', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const talisman = await s.spawn('A', 'Talisman of Dominance Test', 'battlefield')
    await client.query(
      `update public.game_session_players set life_total = 0 where session_id = $1 and player_id = $2`,
      [s.sessionId, s.playerId('A')],
    )

    await client.query('savepoint sp_td3')
    await assert.rejects(() => s.as('A').activateMana(talisman, 1), /Not enough life/)
    await client.query('rollback to savepoint sp_td3')

    assert.equal((await s.cardState(talisman)).is_tapped, false) // not tapped — cost unpaid
  })
})
