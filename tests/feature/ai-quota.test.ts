// Premium AI credits (mig 382). consume_ai_credit is the single server-side
// gate for paid AI features: non-premium users are refused, premium users
// consume a counted credit per call, the monthly cap is enforced atomically,
// and an expired entitlement stops working.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx, rpc, asPlayer } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

interface CreditVerdict {
  allowed: boolean
  reason?: string
  used?: number
  limit?: number
}

before(async () => {
  await ensureTestCards()
})

// co_entitlements FKs to auth.users (like every co_ table); harness players are
// bare UUIDs and the test DB's auth.users is the minimal stub (id/email/meta),
// so provision a stub user for them first.
async function provisionAuthUser(client: { query: (q: string, p: unknown[]) => Promise<unknown> }, id: string) {
  await client.query(
    `insert into auth.users (id, email) values ($1::uuid, ($1::uuid)::text || '@test.local')
     on conflict (id) do nothing`,
    [id],
  )
}

test('AQ1 a non-premium user is refused', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const verdict = await asPlayer(client, s.playerId('A'), () =>
      rpc<CreditVerdict>(client, 'consume_ai_credit', { p_feature: 'deck_doctor', p_limit: 20 }))
    assert.equal(verdict.allowed, false)
    assert.equal(verdict.reason, 'premium_required')
  })
})

test('AQ2 a premium user consumes counted credits up to the cap', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await provisionAuthUser(client, s.playerId('A'))
    await client.query(
      'insert into public.co_entitlements (user_id, premium) values ($1, true)', [s.playerId('A')])

    const first = await asPlayer(client, s.playerId('A'), () =>
      rpc<CreditVerdict>(client, 'consume_ai_credit', { p_feature: 'deck_doctor', p_limit: 2 }))
    assert.equal(first.allowed, true)
    assert.equal(first.used, 1)
    assert.equal(first.limit, 2)

    const second = await asPlayer(client, s.playerId('A'), () =>
      rpc<CreditVerdict>(client, 'consume_ai_credit', { p_feature: 'deck_doctor', p_limit: 2 }))
    assert.equal(second.allowed, true)
    assert.equal(second.used, 2)

    const third = await asPlayer(client, s.playerId('A'), () =>
      rpc<CreditVerdict>(client, 'consume_ai_credit', { p_feature: 'deck_doctor', p_limit: 2 }))
    assert.equal(third.allowed, false)
    assert.equal(third.reason, 'quota_exceeded')
    assert.equal(third.used, 2)
  })
})

test('AQ3 an expired entitlement is refused', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await provisionAuthUser(client, s.playerId('A'))
    await client.query(
      "insert into public.co_entitlements (user_id, premium, premium_until) values ($1, true, now() - interval '1 day')",
      [s.playerId('A')])

    const verdict = await asPlayer(client, s.playerId('A'), () =>
      rpc<CreditVerdict>(client, 'consume_ai_credit', { p_feature: 'deck_doctor', p_limit: 20 }))
    assert.equal(verdict.allowed, false)
    assert.equal(verdict.reason, 'premium_required')
  })
})

test('AQ4 quotas are per feature — one feature at cap leaves another usable', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await provisionAuthUser(client, s.playerId('A'))
    await client.query(
      'insert into public.co_entitlements (user_id, premium) values ($1, true)', [s.playerId('A')])

    const doctor = await asPlayer(client, s.playerId('A'), () =>
      rpc<CreditVerdict>(client, 'consume_ai_credit', { p_feature: 'deck_doctor', p_limit: 1 }))
    assert.equal(doctor.allowed, true)
    const doctorAgain = await asPlayer(client, s.playerId('A'), () =>
      rpc<CreditVerdict>(client, 'consume_ai_credit', { p_feature: 'deck_doctor', p_limit: 1 }))
    assert.equal(doctorAgain.allowed, false)

    const search = await asPlayer(client, s.playerId('A'), () =>
      rpc<CreditVerdict>(client, 'consume_ai_credit', { p_feature: 'nl_search', p_limit: 1 }))
    assert.equal(search.allowed, true)
  })
})
