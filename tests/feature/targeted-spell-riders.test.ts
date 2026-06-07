// Targeted spell riders + nonland_permanent target (mig 150) — Anguished Unmaking:
// "Exile target nonland permanent. You lose 3 life." The permanent_effect action now
// carries an optional `then` rider list applied to the caster, and target_type
// 'nonland_permanent' matches any permanent that isn't a land.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// AU1 — exile a nonland permanent (an enchantment) AND the caster loses 3 life.
test('AU1 exile nonland permanent + lose-3-life rider', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const target = await s.spawn('B', 'Glorious Banner Test', 'battlefield') // Enchantment
    const lifeBefore = await s.lifeOf('A')

    await s.as('A').putOnStack('permanent_effect', {
      kind: 'exile',
      target_card_id: target,
      target_type: 'nonland_permanent',
      then: [{ type: 'lose_life', amount: 3 }],
    })
    await s.resolveStack()

    assert.equal(await s.zoneOf(target), 'exile')
    assert.equal(await s.lifeOf('A'), lifeBefore - 3)
  })
})

// AU2 — a creature is a nonland permanent too, so it's a legal target.
test('AU2 a creature is a legal nonland permanent', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const creature = await s.spawnCreature('B', 'Air Elemental Test')

    await s.as('A').putOnStack('permanent_effect', {
      kind: 'exile',
      target_card_id: creature,
      target_type: 'nonland_permanent',
    })
    await s.resolveStack()

    assert.equal(await s.zoneOf(creature), 'exile')
  })
})

// AU3 — a draw rider draws for the caster.
test('AU3 a draw rider draws for the caster', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const target = await s.spawn('B', 'Bloodforged Blade Test', 'battlefield') // Artifact
    await s.spawn('A', 'Air Elemental Test', 'library') // something to draw
    const handBefore = await s.zoneCount('A', 'hand')

    await s.as('A').putOnStack('permanent_effect', {
      kind: 'destroy',
      target_card_id: target,
      target_type: 'nonland_permanent',
      then: [{ type: 'draw', amount: 1 }],
    })
    await s.resolveStack()

    assert.equal(await s.zoneOf(target), 'graveyard')
    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 1)
  })
})

// AU4 — a LAND cannot be targeted by a nonland_permanent spell (kept last: the
// expected rejection aborts the test transaction).
test('AU4 a land is not a legal nonland permanent', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const land = await s.spawn('B', 'Wastes Test', 'battlefield') // Basic Land

    await assert.rejects(
      () =>
        s.as('A').putOnStack('permanent_effect', {
          kind: 'exile',
          target_card_id: land,
          target_type: 'nonland_permanent',
        }),
      /not a legal permanent/i,
    )
  })
})
