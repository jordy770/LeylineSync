// mig 404 — exile_until_leaves gains multi-target ("up to three") + a
// return_to destination. Angel of Serenity exiles up to three creatures on
// ETB and returns them to their owners' HANDS when it leaves (not the
// battlefield, which is the Bronzebeak Foragers default).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// EL1 — exile two, then bounce the Angel: both exiled creatures go to their
// owners' HANDS, and the default battlefield return does NOT apply.
test('EL1 exile_until_leaves return_to hand sends the exiled cards to hand', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const mine = await s.spawnCreature('A', 'Goblin Raider Test')
    const theirs = await s.spawnCreature('B', 'Air Elemental Test')
    const angel = await s.spawnCreature('A', 'Serenity Angel Test')

    const trigger = await s.topStackItem()
    assert.equal(trigger?.action_type, 'triggered_ability')
    assert.equal(trigger?.payload?.target_count, 3)
    await s.as('A').chooseTriggerTargets(trigger!.id, [mine, theirs])
    await s.resolveStack()

    assert.equal(await s.zoneOf(mine), 'exile')
    assert.equal(await s.zoneOf(theirs), 'exile')

    // Angel leaves the battlefield (destroyed) — the LTB return fires via the
    // zone-change trigger and sends the exiled cards to their owners' hands.
    await s.client.query(
      `select public.apply_creature_effect($1, 'destroy', $2, '{}'::jsonb)`,
      [s.sessionId, angel])

    assert.equal(await s.zoneOf(angel), 'graveyard')
    assert.equal(await s.zoneOf(mine), 'hand')
    assert.equal(await s.zoneOf(theirs), 'hand')
  })
})

// EL2 — "up to": exiling ONE is legal; only that card returns to hand.
test('EL2 exile_until_leaves accepts fewer than the max', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const theirs = await s.spawnCreature('B', 'Air Elemental Test')
    const other = await s.spawnCreature('B', 'Goblin Raider Test')
    const angel = await s.spawnCreature('A', 'Serenity Angel Test')

    const trigger = await s.topStackItem()
    await s.as('A').chooseTriggerTargets(trigger!.id, [theirs])
    await s.resolveStack()

    assert.equal(await s.zoneOf(theirs), 'exile')
    assert.equal(await s.zoneOf(other), 'battlefield')
  })
})
