// Phase 1, slice 6 — scry / surveil from inside a triggered ability.
//
// Proves resumable trigger resolution: an ETB trigger that scrys/surveils parks
// mid-resolution (apply_trigger_effects), and submit_decision resumes the trigger
// from where it left off — including effects that come AFTER the scry.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function fillLibrary(s: Scenario, n: number): Promise<string[]> {
  for (let i = 0; i < n; i++) await s.spawn('A', 'Air Elemental Test', 'library')
  return s.libraryIds('A')
}

// TSC1 — an ETB "scry 2" trigger parks, then resolves on submit.
test('TSC1 ETB scry trigger parks and resolves via submit', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const before = await fillLibrary(s, 4) // [c0, c1, c2, c3]

    // Spawning to the battlefield fires the ETB trigger onto the stack.
    await s.spawnCreature('A', 'Scry Seer Test')
    const item = await s.topStackItem()
    assert.equal(item?.action_type, 'triggered_ability')

    const res = (await s.as('A').resolveStack()) as Record<string, unknown>
    assert.equal(res.awaiting_decision, true)

    const decision = await s.pendingDecision()
    assert.equal(decision?.decision_type, 'scry')
    // Bottom c0, keep c1 on top.
    await s.as('A').submitDecision(decision!.id, { top: [before[1]], bottom: [before[0]] })

    assert.deepEqual(await s.libraryIds('A'), [before[1], before[2], before[3], before[0]])
    assert.equal(await s.stackStatus(item!.id), 'resolved')
  })
})

// TSC2 — an ETB "surveil 2" trigger bins a card to the graveyard.
test('TSC2 ETB surveil trigger bins to the graveyard', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const before = await fillLibrary(s, 4)

    await s.spawnCreature('A', 'Surveil Seer Test')
    await s.as('A').resolveStack()
    const decision = await s.pendingDecision()
    await s.as('A').submitDecision(decision!.id, { graveyard: [before[0]], top: [before[1]] })

    assert.equal(await s.zoneOf(before[0]), 'graveyard')
    assert.deepEqual(await s.libraryIds('A'), [before[1], before[2], before[3]])
  })
})

// TSC3 — a later effect runs only AFTER the scry decision resumes the trigger.
test('TSC3 effect after the scry runs only on resume', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const before = await fillLibrary(s, 2)
    const lifeBefore = await s.lifeOf('A')

    // Trigger effects = [scry 1, gain_life 2]. Resolving parks on the scry first.
    await s.spawnCreature('A', 'Scry Then Gain Test')
    await s.as('A').resolveStack()

    // The gain_life has NOT happened yet — we're parked on the scry.
    assert.equal(await s.lifeOf('A'), lifeBefore)

    const decision = await s.pendingDecision()
    assert.equal(decision?.decision_type, 'scry')
    await s.as('A').submitDecision(decision!.id, { top: [before[0]], bottom: [] })

    // Resume ran the gain_life after the scry.
    assert.equal(await s.lifeOf('A'), lifeBefore + 2)
  })
})
