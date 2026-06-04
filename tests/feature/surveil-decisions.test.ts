// Phase 1, slice 4 — Tier-B resolution-time decision: surveil.
//
// Same park/resume seam as scry, but the "binned" cards go to the graveyard
// instead of the bottom of the library. Library top = lowest zone_position.

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

// SV1 — a surveil parks the stack item and opens a surveil decision.
test('SV1 surveil parks the stack item awaiting a decision', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await fillLibrary(s, 3)

    const item = await s.as('A').castSurveil(2)
    const res = (await s.as('A').resolveStack()) as Record<string, unknown>

    assert.equal(res.awaiting_decision, true)
    assert.equal(res.decision_type, 'surveil')
    assert.equal(await s.stackStatus(item.id), 'awaiting_decision')

    const decision = await s.pendingDecision()
    assert.equal(decision?.decision_type, 'surveil')
    assert.equal((decision?.options as unknown[]).length, 2)
  })
})

// SV2 — keeping both on top leaves the library unchanged and the graveyard empty.
test('SV2 surveil keeping both on top changes nothing', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const before = await fillLibrary(s, 4)

    const item = await s.as('A').castSurveil(2)
    await s.as('A').resolveStack()
    const decision = await s.pendingDecision()

    await s.as('A').submitDecision(decision!.id, { graveyard: [], top: [before[0], before[1]] })

    assert.deepEqual(await s.libraryIds('A'), before)
    assert.equal(await s.zoneCount('A', 'graveyard'), 0)
    assert.equal(await s.stackStatus(item.id), 'resolved')
  })
})

// SV3 — binning the top card moves it to the graveyard and shrinks the library.
test('SV3 surveil binning a card moves it to the graveyard', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const before = await fillLibrary(s, 4) // [c0, c1, c2, c3]

    await s.as('A').castSurveil(2)
    await s.as('A').resolveStack()
    const decision = await s.pendingDecision()
    // Bin c0, keep c1 on top.
    await s.as('A').submitDecision(decision!.id, { graveyard: [before[0]], top: [before[1]] })

    assert.deepEqual(await s.libraryIds('A'), [before[1], before[2], before[3]])
    assert.equal(await s.zoneOf(before[0]), 'graveyard')
    assert.equal(await s.zoneCount('A', 'graveyard'), 1)
  })
})

// SV4 — the submitted cards must be exactly the revealed cards.
test('SV4 surveil rejects a result that does not place every revealed card', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const before = await fillLibrary(s, 3)

    await s.as('A').castSurveil(2)
    await s.as('A').resolveStack()
    const decision = await s.pendingDecision()
    // Places neither half fully (only one of two revealed).
    await assert.rejects(() => s.as('A').submitDecision(decision!.id, { graveyard: [before[0]], top: [] }))
  })
})
