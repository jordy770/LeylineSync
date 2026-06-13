// Undermine — "Counter target spell. Its controller loses 2 life." (mig 190). A
// life-loss rider on a counterspell: the COUNTERED spell's controller loses the
// life, not the caster. The amount rides on the counter spell's own `counter`
// action (controller_loses_life), read by handle_counter_spell from its source.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// UN1 — counters a normal spell AND its controller (A) loses 2 life; the caster
// of Undermine (B) is unaffected.
test('UN1 counters the spell and its controller loses 2 life', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const opt = await s.spawn('A', 'Opt Test', 'hand')
    const target = await s.as('A').castSpellEffect([{ type: 'draw', amount: 1 }], opt)
    const aLifeBefore = await s.lifeOf('A')
    const bLifeBefore = await s.lifeOf('B')

    const undermine = await s.spawn('B', 'Undermine Test', 'hand')
    await s.setMana('B', { U: 1, B: 1 }) // {U}{B}
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'B' })
    await s.as('B').putOnStack('counter_spell', { target_stack_item_id: target.id }, undermine)
    await s.resolveStack()

    assert.equal(await s.stackStatus(target.id), 'cancelled') // countered
    assert.equal(await s.lifeOf('A'), aLifeBefore - 2) // its controller loses 2
    assert.equal(await s.lifeOf('B'), bLifeBefore) // the caster is unaffected
  })
})

// UN2 — the life-loss rider applies even when the target can't be countered (the
// two instructions resolve independently): the spell survives, A still loses 2.
test('UN2 the life loss still applies to an uncounterable spell', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const bolt = await s.spawn('A', 'Unyielding Bolt Test', 'hand') // cant_be_countered
    const target = await s.as('A').castSpellEffect([{ type: 'draw', amount: 1 }], bolt)
    const aLifeBefore = await s.lifeOf('A')

    const undermine = await s.spawn('B', 'Undermine Test', 'hand')
    await s.setMana('B', { U: 1, B: 1 }) // {U}{B}
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'B' })
    await s.as('B').putOnStack('counter_spell', { target_stack_item_id: target.id }, undermine)
    await s.resolveStack()

    assert.equal(await s.stackStatus(target.id), 'pending') // not countered
    assert.equal(await s.lifeOf('A'), aLifeBefore - 2) // but its controller still loses 2
  })
})
