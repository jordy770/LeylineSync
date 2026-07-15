// mig 398 — flash in the cast timing gate: a nonland hand card with keyword
// flash (printed or scripted), or covered by a 'flash_permission' static
// ("cast artifact spells as though they had flash" — Shimmer Myr), may be cast
// whenever its controller holds priority — off-turn, outside main phases.
// Cards without it still hit the sorcery-speed gate.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// FL1 — keyword flash: castable on the OPPONENT's turn while holding priority.
test('FL1 a flash creature casts at instant speed off-turn', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const bear = await s.spawn('A', 'Flash Bear Test', 'hand')
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'B', priority: 'A' })

    await s.as('A').castPermanent(bear)
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(bear), 'battlefield')
  })
})

// FL2 — flash_permission static: an artifact becomes flashable while the
// grantor is on the battlefield; a creature card is still gated.
test('FL2 flash_permission covers matching spells only', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawn('A', 'Artifact Flash Grantor Test', 'battlefield')
    const wellspring = await s.spawn('A', 'Ichor Wellspring Test', 'hand')
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'B', priority: 'A' })

    await s.setMana('A', { C: 2 })
    await s.as('A').castPermanent(wellspring)
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()
    assert.equal(await s.zoneOf(wellspring), 'battlefield')

    // Expected rejection LAST (an aborted tx poisons later statements): a
    // plain creature is not covered by the artifact-only permission. The cast
    // above handed priority back to the active player — reclaim it first so
    // the failure is the TIMING gate, not the priority check.
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'B', priority: 'A' })
    const raider = await s.spawn('A', 'Goblin Raider Test', 'hand')
    await s.setMana('A', { R: 1 })
    await assert.rejects(
      s.as('A').castPermanent(raider),
      /active player|main phase/,
    )
  })
})
