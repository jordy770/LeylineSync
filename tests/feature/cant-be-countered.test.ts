// "Can't be countered": a counter that targets an uncounterable spell resolves
// but fails to cancel it. The counterspell still leaves the stack normally.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// CC1 — countering an uncounterable spell leaves it on the stack (pending).
test('CC1 cant_be_countered spell survives a counter', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    // A casts an uncounterable instant from hand.
    const bolt = await s.spawn('A', 'Unyielding Bolt Test', 'hand')
    const target = await s.as('A').castSpellEffect([{ type: 'draw', amount: 1 }], bolt)

    // B tries to counter it.
    const counterSource = await s.spawn('B', 'Doom Blade Test', 'hand')
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'B' })
    await s.as('B').putOnStack('counter_spell', { target_stack_item_id: target.id }, counterSource)
    await s.resolveStack() // resolves the counter (top) — should NOT cancel the bolt

    assert.equal(await s.stackStatus(target.id), 'pending')
  })
})

// CC2 — contrast: a normal spell (no flag) is still cancelled by the counter.
test('CC2 a normal spell is still countered', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const opt = await s.spawn('A', 'Opt Test', 'hand')
    const target = await s.as('A').castSpellEffect([{ type: 'draw', amount: 1 }], opt)

    const counterSource = await s.spawn('B', 'Doom Blade Test', 'hand')
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'B' })
    await s.as('B').putOnStack('counter_spell', { target_stack_item_id: target.id }, counterSource)
    await s.resolveStack()

    assert.equal(await s.stackStatus(target.id), 'cancelled')
  })
})
