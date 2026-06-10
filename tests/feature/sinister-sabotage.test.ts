// Sinister Sabotage (mig 204) — "Counter target spell. Surveil 1." A `surveil`
// rider on the counter action: handle_counter_spell reads it from the counter
// spell's own script (mirrors Undermine's controller_loses_life) and enqueues a
// surveil trigger for the counter's CASTER, which parks the usual surveil
// decision. The rider applies even when the target can't be countered.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// SS1 — counter the spell, then the caster surveils 1 (bin the top card).
test('SS1 counter resolves, then the caster surveils', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    // B's library needs a card to surveil.
    const bTop = await s.spawn('B', 'Air Elemental Test', 'library')

    const opt = await s.spawn('A', 'Opt Test', 'hand')
    const target = await s.as('A').castSpellEffect([{ type: 'draw', amount: 1 }], opt)

    const sabotage = await s.spawn('B', 'Sinister Sabotage Test', 'hand')
    await s.setMana('B', { U: 2, C: 1 }) // {1}{U}{U}
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'B' })
    await s.as('B').putOnStack('counter_spell', { target_stack_item_id: target.id }, sabotage)
    await s.resolveStack() // counter resolves; surveil trigger enqueued for B

    assert.equal(await s.stackStatus(target.id), 'cancelled') // countered

    const res = (await s.as('B').resolveStack()) as Record<string, unknown>
    assert.equal(res.awaiting_decision, true) // the surveil parks for B

    const decision = await s.pendingDecision()
    assert.equal(decision?.decision_type, 'surveil')
    await s.as('B').submitDecision(decision!.id, { graveyard: [bTop], top: [] })
    assert.equal(await s.zoneOf(bTop), 'graveyard')
  })
})

// SS2 — the surveil still happens when the target can't be countered.
test('SS2 surveil applies even against an uncounterable spell', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const bTop = await s.spawn('B', 'Air Elemental Test', 'library')
    const bolt = await s.spawn('A', 'Unyielding Bolt Test', 'hand') // cant_be_countered
    const target = await s.as('A').castSpellEffect([{ type: 'draw', amount: 1 }], bolt)

    const sabotage = await s.spawn('B', 'Sinister Sabotage Test', 'hand')
    await s.setMana('B', { U: 2, C: 1 })
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'B' })
    await s.as('B').putOnStack('counter_spell', { target_stack_item_id: target.id }, sabotage)
    await s.resolveStack()

    assert.equal(await s.stackStatus(target.id), 'pending') // survives

    await s.as('B').resolveStack() // the surveil trigger still parks
    const decision = await s.pendingDecision()
    assert.equal(decision?.decision_type, 'surveil')
    await s.as('B').submitDecision(decision!.id, { graveyard: [], top: [bTop] }) // keep on top

    assert.equal(await s.zoneOf(bTop), 'library')
  })
})
