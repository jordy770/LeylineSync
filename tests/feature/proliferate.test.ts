// Proliferate (Atraxa, Praetors' Voice end step, Karn's Bastion, etc.). The engine
// models only +1/+1 counters, so proliferate = "choose any number of permanents with
// a +1/+1 counter (any owner), each gets another." A choice → a pending decision that
// reuses the multi-select CardPickBody path. Cast here as an untargeted spell_effect
// program — the same path the triggered ability uses. Mirrors sacrifice-reanimate.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// Give a battlefield permanent some starting +1/+1 counters.
async function setCounters(s: Scenario, card: string, n: number) {
  await s.client.query('update public.game_cards set plus_one_counters = $2 where id = $1', [card, n])
}

// PRO1 — chosen permanents each gain a counter; unchosen ones are untouched.
test('PRO1 proliferate adds one counter to each chosen permanent', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const a = await s.spawnCreature('A', 'Air Elemental Test')
    const b = await s.spawnCreature('B', 'Deathtouch Viper Test')
    await setCounters(s, a, 2)
    await setCounters(s, b, 1)

    await s.as('A').castSpellEffect([{ type: 'proliferate' }])
    const res = (await s.as('A').resolveStack()) as Record<string, unknown>
    assert.equal(res.awaiting_decision, true)

    const decision = await s.pendingDecision()
    assert.equal(decision?.decision_type, 'proliferate')
    assert.equal(decision?.deciding_player_id, s.playerId('A')) // controller chooses
    // Both A's and B's counter-bearing permanents are offered (any owner).
    assert.equal((decision?.options as unknown[]).length, 2)

    await s.as('A').submitDecision(decision!.id, { chosen: [a] })

    assert.equal((await s.cardState(a)).plus_one_counters, 3) // 2 → 3
    assert.equal((await s.cardState(b)).plus_one_counters, 1) // unchosen, unchanged
  })
})

// PRO2 — "any number" includes zero: declining leaves every counter as-is.
test('PRO2 proliferate may choose zero (decline)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const a = await s.spawnCreature('A', 'Air Elemental Test')
    await setCounters(s, a, 1)

    const item = await s.as('A').castSpellEffect([{ type: 'proliferate' }])
    await s.as('A').resolveStack()
    const decision = await s.pendingDecision()
    assert.equal(decision?.min_choices, 0)

    await s.as('A').submitDecision(decision!.id, { chosen: [] })

    assert.equal((await s.cardState(a)).plus_one_counters, 1) // unchanged
    assert.equal(await s.stackStatus(item.id), 'resolved')
  })
})

// PRO3 — no permanent has a counter → no decision, the spell just resolves.
test('PRO3 proliferate with no counters on the battlefield resolves cleanly', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Air Elemental Test') // no counters

    const item = await s.as('A').castSpellEffect([{ type: 'proliferate' }])
    const res = (await s.as('A').resolveStack()) as Record<string, unknown>

    assert.notEqual(res.awaiting_decision, true)
    assert.equal(await s.pendingDecision(), null)
    assert.equal(await s.stackStatus(item.id), 'resolved')
  })
})
