// Phase 1, slice 3 — Tier-B resolution-time decisions: scry.
//
// Proves the suspend/resume seam: resolve_top_of_stack PARKS a scry item and
// returns { awaiting_decision: true }; submit_decision applies the reorder and
// resumes via finalize_stack_resolution. Library top = lowest zone_position.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx, asPlayer, rpc } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// Fill seat A's library with `n` cards; returns their ids top-to-bottom.
async function fillLibrary(s: Scenario, n: number): Promise<string[]> {
  for (let i = 0; i < n; i++) await s.spawn('A', 'Air Elemental Test', 'library')
  return s.libraryIds('A')
}

// SC1 — a scry parks the stack item and opens a scry decision.
test('SC1 scry parks the stack item awaiting a decision', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await fillLibrary(s, 3)

    const item = await s.as('A').castScry(2)
    const res = (await s.as('A').resolveStack()) as Record<string, unknown>

    assert.equal(res.awaiting_decision, true)
    assert.equal(res.decision_type, 'scry')
    assert.equal(await s.stackStatus(item.id), 'awaiting_decision')

    const decision = await s.pendingDecision()
    assert.equal(decision?.decision_type, 'scry')
    assert.equal((decision?.options as unknown[]).length, 2) // only the top 2 revealed
  })
})

// SC2 — keeping both on top in order leaves the library unchanged.
test('SC2 scry keeping order leaves the library unchanged', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const before = await fillLibrary(s, 4) // [c0, c1, c2, c3]

    const item = await s.as('A').castScry(2)
    await s.as('A').resolveStack()
    const decision = await s.pendingDecision()

    await s.as('A').submitDecision(decision!.id, { top: [before[0], before[1]], bottom: [] })

    assert.deepEqual(await s.libraryIds('A'), before)
    assert.equal(await s.stackStatus(item.id), 'resolved')
  })
})

// SC3 — putting the top card on the bottom reorders correctly.
test('SC3 scry bottoming a card moves it below the rest of the library', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const before = await fillLibrary(s, 4) // [c0, c1, c2, c3]

    await s.as('A').castScry(2)
    await s.as('A').resolveStack()
    const decision = await s.pendingDecision()
    // Keep c1 on top, send c0 to the bottom.
    await s.as('A').submitDecision(decision!.id, { top: [before[1]], bottom: [before[0]] })

    // Expected: c1, c2, c3, then c0 at the very bottom.
    assert.deepEqual(await s.libraryIds('A'), [before[1], before[2], before[3], before[0]])
  })
})

// SC4 — only the deciding player may submit the scry.
test('SC4 a non-deciding player cannot submit the scry', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const before = await fillLibrary(s, 3)

    await s.as('A').castScry(2)
    await s.as('A').resolveStack()
    const decision = await s.pendingDecision()
    await assert.rejects(() => s.as('B').submitDecision(decision!.id, { top: [before[0], before[1]], bottom: [] }))
  })
})

// SC5 — the submitted cards must be exactly the revealed cards.
test('SC5 scry rejects a result that does not place every revealed card', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const before = await fillLibrary(s, 3)

    await s.as('A').castScry(2)
    await s.as('A').resolveStack()
    const decision = await s.pendingDecision()
    // Only places one of the two revealed cards.
    await assert.rejects(() => s.as('A').submitDecision(decision!.id, { top: [before[0]], bottom: [] }))
  })
})

// SC6 — a pending decision freezes priority: pass_priority is rejected until it's submitted.
test('SC6 cannot pass priority while a scry decision is pending', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await fillLibrary(s, 2)

    await s.as('A').castScry(1)
    await s.as('A').resolveStack() // parks; a scry decision is now pending

    await assert.rejects(() => asPlayer(client, s.players.A, () => rpc(client, 'pass_priority', { p_session_id: s.sessionId })))
  })
})
