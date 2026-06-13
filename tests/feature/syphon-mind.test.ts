// Syphon Mind (mig 298): each other player discards a card (each_opponent, at
// random), then you draw a card for each card discarded this way (~num_opponents).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// SYPH1 — 3 players: B and C each discard 1; the caster draws 2.
test('SYPH1 each opponent discards and the caster draws one per opponent', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 3)
    const syphon = await s.spawn('A', 'Syphon Test', 'hand')
    await s.spawn('B', 'Air Elemental Test', 'hand')
    await s.spawn('C', 'Air Elemental Test', 'hand')
    await s.spawn('A', 'Air Elemental Test', 'library')
    await s.spawn('A', 'Air Elemental Test', 'library')

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { B: 1, C: 2 })
    const aHandBefore = await s.zoneCount('A', 'hand')

    await s.as('A').castSpellEffect(
      [
        { type: 'discard', who: 'each_opponent', count: 1, random: true },
        { type: 'draw', amount: { count: 'num_opponents' }, recipient: 'controller' },
      ],
      syphon,
    )
    await s.as('A').resolveStack()

    assert.equal(await s.zoneCount('B', 'hand'), 0)            // B discarded its card
    assert.equal(await s.zoneCount('C', 'hand'), 0)            // C discarded its card
    assert.equal(await s.zoneCount('A', 'hand'), aHandBefore - 1 + 2) // cast Syphon, drew 2
  })
})
