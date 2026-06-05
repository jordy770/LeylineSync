// Phase 4 / F2.2a — set-P/T layering (mig 128, CR 613 layer 7b). A set_pt effect
// REPLACES the printed base; counters (7c) and pumps (7d) then add on top.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function setCounters(s: Scenario, card: string, n: number) {
  await s.client.query('update public.game_cards set plus_one_counters = $2 where id = $1', [card, n])
}

async function addPump(s: Scenario, card: string, power: number, toughness: number) {
  await s.client.query(
    `insert into public.game_continuous_effects (session_id, affected_card_id, effect_type, payload)
     values ($1, $2, 'pump', jsonb_build_object('power', $3::int, 'toughness', $4::int))`,
    [s.sessionId, card, power, toughness],
  )
}

// L1 — set 0/1 REPLACES the 4/4 base; a +1/+1 counter then makes it 1/2.
test('L1 a set effect replaces the base, then counters add', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const c = await s.spawnCreature('A', 'Air Elemental Test') // 4/4
    await s.setBasePT(c, 0, 1)
    await setCounters(s, c, 1)

    assert.equal(await s.effectivePower(c), 1) // 0 set + 1 counter
    assert.equal(await s.effectiveToughness(c), 2) // 1 set + 1 counter
  })
})

// L2 — set 0/1 then a +3/+3 pump → 3/4 (pumps layer above the set).
test('L2 pumps add on top of a set base', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const c = await s.spawnCreature('A', 'Air Elemental Test') // 4/4
    await s.setBasePT(c, 0, 1)
    await addPump(s, c, 3, 3)

    assert.equal(await s.effectivePower(c), 3) // 0 + 3 pump
    assert.equal(await s.effectiveToughness(c), 4) // 1 + 3 pump
  })
})

// L3 — no set effect: the flat base + counters behavior is unchanged (regression).
test('L3 without a set effect, base + counters is unchanged', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const c = await s.spawnCreature('A', 'Air Elemental Test') // 4/4
    await setCounters(s, c, 2)

    assert.equal(await s.effectivePower(c), 6)
    assert.equal(await s.effectiveToughness(c), 6)
  })
})

// L4 — when two set effects apply, the most recent (by created_at) wins. now() is
// constant per-tx, so the timestamps are set explicitly to be deterministic.
test('L4 the most recent set effect wins', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const c = await s.spawnCreature('A', 'Air Elemental Test')

    await s.client.query(
      `insert into public.game_continuous_effects (session_id, affected_card_id, effect_type, payload, created_at)
       values ($1, $2, 'set_pt', '{"power":0,"toughness":1}'::jsonb, now()),
              ($1, $2, 'set_pt', '{"power":2,"toughness":2}'::jsonb, now() + interval '1 second')`,
      [s.sessionId, c],
    )

    assert.equal(await s.effectivePower(c), 2) // the later 2/2 set wins
    assert.equal(await s.effectiveToughness(c), 2)
  })
})

// SP1 — F2.2b: a set_pt_creature spell sets a target creature's base P/T.
test('SP1 a set_pt spell makes a creature become 0/1', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const c = await s.spawnCreature('B', 'Air Elemental Test') // 4/4

    await s.as('A').putOnStack('set_pt_creature', { target_card_id: c, power: 0, toughness: 1, target_controller: 'any' })
    await s.as('A').resolveStack()

    assert.equal(await s.effectivePower(c), 0)
    assert.equal(await s.effectiveToughness(c), 1)
  })
})

// SP2 — counters still layer on top of the spell's set base.
test('SP2 counters layer on top of a set_pt spell', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const c = await s.spawnCreature('B', 'Air Elemental Test')

    await s.as('A').putOnStack('set_pt_creature', { target_card_id: c, power: 0, toughness: 1, target_controller: 'any' })
    await s.as('A').resolveStack()
    await setCounters(s, c, 1)

    assert.equal(await s.effectivePower(c), 1)
    assert.equal(await s.effectiveToughness(c), 2)
  })
})

// SP3 — the set wears off at end of turn (the cleanup sweep removes it).
test('SP3 a set_pt spell wears off at end of turn', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const c = await s.spawnCreature('B', 'Air Elemental Test') // 4/4

    await s.as('A').putOnStack('set_pt_creature', { target_card_id: c, power: 0, toughness: 1, target_controller: 'any' })
    await s.as('A').resolveStack()
    assert.equal(await s.effectivePower(c), 0)

    await s.as('A').expireEffects('ending', 'cleanup')

    assert.equal(await s.effectivePower(c), 4) // back to printed 4/4
    assert.equal(await s.effectiveToughness(c), 4)
  })
})
