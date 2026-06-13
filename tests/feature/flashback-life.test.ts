// Flashback with an additional "Pay N life" cost (mig 176). Deep Analysis's
// flashback is "{1}{U}, Pay 3 life": the graveyard cast pays the flashback mana
// AND 3 life, then the card is exiled. A normal hand cast pays neither.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// Deep Analysis's spell program (target player draws two).
const DA_ACTIONS = [{ type: 'choose_player', filter: 'any', effects: [{ type: 'draw', amount: 2 }] }]

// FBL1 — flashback pays the mana AND 3 life, then exiles the card.
test('FBL1 flashback pays the extra life cost and exiles', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const da = await s.spawn('A', 'Deep Analysis Test', 'graveyard')
    await s.setMana('A', { U: 1, C: 1 }) // flashback {1}{U}
    const lifeBefore = await s.lifeOf('A')

    await s.as('A').castSpellEffect(DA_ACTIONS, da)

    assert.equal(await s.lifeOf('A'), lifeBefore - 3) // paid 3 life
    assert.equal(await s.zoneOf(da), 'exile') // exiled on flashback cast
  })
})

// FBL2 — you cannot flashback if you can't pay the life (life < cost).
test('FBL2 flashback is rejected when life is insufficient', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const da = await s.spawn('A', 'Deep Analysis Test', 'graveyard')
    await s.setMana('A', { U: 1, C: 1 })
    await s.client.query(
      'update public.game_session_players set life_total = 2 where session_id = $1 and player_id = $2',
      [s.sessionId, s.players.A],
    )

    await client.query('savepoint sp_fbl2')
    await assert.rejects(
      () => s.as('A').castSpellEffect(DA_ACTIONS, da),
      /Not enough life to pay the flashback cost/,
    )
    await client.query('rollback to savepoint sp_fbl2')

    assert.equal(await s.zoneOf(da), 'graveyard') // unmoved — cast never happened
  })
})
