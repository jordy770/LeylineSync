// Phase 1, slice 7 — multi-action untargeted spell program (e.g. Opt).
//
// A non-permanent spell whose resolution is a list of untargeted effects runs
// each in order (parking on a scry/surveil), and the spell card goes to the
// graveyard on cast like any instant/sorcery.

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

// SE1 — Opt: the spell card hits the graveyard on cast, scry parks, draw runs on resume.
test('SE1 Opt scrys then draws and the spell goes to the graveyard', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await fillLibrary(s, 3)

    const opt = await s.spawn('A', 'Opt Test', 'hand')
    const item = await s.as('A').castSpellEffect([{ type: 'scry', amount: 1 }, { type: 'draw', amount: 1 }], opt)

    // Cast moved the instant from hand to the graveyard immediately.
    assert.equal(await s.zoneOf(opt), 'graveyard')

    const handAfterCast = await s.zoneCount('A', 'hand')
    const libAfterCast = await s.zoneCount('A', 'library')

    // Resolving parks on the scry (the draw has NOT happened yet).
    const res = (await s.as('A').resolveStack()) as Record<string, unknown>
    assert.equal(res.awaiting_decision, true)
    assert.equal(await s.zoneCount('A', 'hand'), handAfterCast)

    const decision = await s.pendingDecision()
    assert.equal(decision?.decision_type, 'scry')
    await s.as('A').submitDecision(decision!.id, { top: (decision!.options as { game_card_id: string }[]).map((o) => o.game_card_id), bottom: [] })

    // Resume drew a card: hand +1, library -1, spell fully resolved.
    assert.equal(await s.zoneCount('A', 'hand'), handAfterCast + 1)
    assert.equal(await s.zoneCount('A', 'library'), libAfterCast - 1)
    assert.equal(await s.stackStatus(item.id), 'resolved')
  })
})
