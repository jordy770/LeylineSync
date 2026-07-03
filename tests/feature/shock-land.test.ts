// Shock lands (mig 327) — "enters tapped UNLESS you pay 2 life". Playing one puts
// it on the battlefield TAPPED and raises a pay_life_untap decision; paying untaps
// it for 2 life, declining leaves it tapped. (enters_tapped: {unless:{pay_life:2}}.)

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx, asPlayer, rpc } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

const pendingPayLifeDecision = async (
  client: Parameters<Parameters<typeof withRolledBackTx>[0]>[0],
  sessionId: string,
  playerId: string,
): Promise<string | null> => {
  const r = await client.query<{ id: string }>(
    `select id from public.game_pending_decisions
     where session_id = $1 and deciding_player_id = $2 and decision_type = 'pay_life_untap' and status = 'pending'`,
    [sessionId, playerId],
  )
  return r.rows[0]?.id ?? null
}

// SL1 — declining the payment leaves the shock land tapped, life unchanged.
test('SL1 shock land enters tapped and stays tapped when you decline to pay', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const shock = await s.spawn('A', 'Shock Land Test', 'hand')
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const lifeBefore = await s.lifeOf('A')

    await s.as('A').castPermanent(shock)
    assert.equal((await s.cardState(shock)).is_tapped, true, 'enters tapped')

    const decisionId = await pendingPayLifeDecision(client, s.sessionId, s.playerId('A'))
    assert.ok(decisionId, 'a pay_life_untap decision was raised')
    await asPlayer(client, s.playerId('A'), () =>
      rpc(client, 'submit_decision', { p_decision_id: decisionId, p_result: JSON.stringify({ confirmed: false }) }))

    assert.equal((await s.cardState(shock)).is_tapped, true, 'still tapped after declining')
    assert.equal(await s.lifeOf('A'), lifeBefore, 'no life paid')
  })
})

// SL2 — paying 2 life untaps it.
test('SL2 paying 2 life untaps the shock land', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const shock = await s.spawn('A', 'Shock Land Test', 'hand')
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const lifeBefore = await s.lifeOf('A')

    await s.as('A').castPermanent(shock)
    const decisionId = await pendingPayLifeDecision(client, s.sessionId, s.playerId('A'))
    assert.ok(decisionId, 'a pay_life_untap decision was raised')
    await asPlayer(client, s.playerId('A'), () =>
      rpc(client, 'submit_decision', { p_decision_id: decisionId, p_result: JSON.stringify({ confirmed: true }) }))

    assert.equal((await s.cardState(shock)).is_tapped, false, 'untapped after paying')
    assert.equal(await s.lifeOf('A'), lifeBefore - 2, 'paid 2 life')
  })
})
