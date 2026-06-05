// Phase 3, slice 2 — non-creature permanent targets (mig 113): the
// `permanent_effect` action type applies a removal kind (destroy/exile/bounce/
// tap/untap) to a target permanent of any type (artifact/enchantment/land/
// planeswalker/permanent). Cast directly via put_action_on_stack (the path the
// client wrapper uses). Uses the existing non-creature fixtures.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// PE1 — destroy a target artifact (Disenchant): it goes to the graveyard.
test('PE1 permanent_effect destroys a target artifact', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const art = await s.spawn('B', 'Green Mana Vessel Test', 'battlefield')

    const item = await s
      .as('A')
      .putOnStack('permanent_effect', { kind: 'destroy', target_card_id: art, target_type: 'artifact', target_controller: 'any' })
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(art), 'graveyard')
    assert.equal(await s.stackStatus(item.id), 'resolved')
  })
})

// PE2 — exile a target enchantment: it goes to exile.
test('PE2 permanent_effect exiles a target enchantment', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const ench = await s.spawn('B', 'Exploration Test', 'battlefield')

    await s
      .as('A')
      .putOnStack('permanent_effect', { kind: 'exile', target_card_id: ench, target_type: 'enchantment' })
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(ench), 'exile')
  })
})

// PE3 — a type mismatch is rejected at cast (destroy artifact can't target a creature).
test('PE3 permanent_effect rejects a target of the wrong type', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const creature = await s.spawnCreature('B', 'Air Elemental Test')

    await assert.rejects(
      () =>
        s
          .as('A')
          .putOnStack('permanent_effect', { kind: 'destroy', target_card_id: creature, target_type: 'artifact' }),
      /legal permanent/,
    )
  })
})

// PE4 — target_type "permanent" matches anything on the battlefield (Beast Within
// hits a creature too — a creature IS a permanent).
test('PE4 permanent_effect with target_type permanent hits any permanent', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const creature = await s.spawnCreature('B', 'Air Elemental Test')

    await s
      .as('A')
      .putOnStack('permanent_effect', { kind: 'destroy', target_card_id: creature, target_type: 'permanent' })
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(creature), 'graveyard')
  })
})

// PE5 — the controller restriction is enforced (can't Disenchant your own artifact
// with a "target artifact an opponent controls" spell).
test('PE5 permanent_effect enforces the controller restriction', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const myArt = await s.spawn('A', 'Green Mana Vessel Test', 'battlefield')

    await assert.rejects(
      () =>
        s
          .as('A')
          .putOnStack('permanent_effect', {
            kind: 'destroy',
            target_card_id: myArt,
            target_type: 'artifact',
            target_controller: 'opponent',
          }),
      /legal permanent/,
    )
  })
})

// PE6 — an array target_type matches if any type matches (artifact OR enchantment).
test('PE6 permanent_effect accepts an array target_type', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const ench = await s.spawn('B', 'Exploration Test', 'battlefield')

    await s
      .as('A')
      .putOnStack('permanent_effect', { kind: 'destroy', target_card_id: ench, target_type: ['artifact', 'enchantment'] })
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(ench), 'graveyard')
  })
})
