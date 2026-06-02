// Feature group 082 — the new trigger events: leaves_the_battlefield,
// beginning_of_draw_step, beginning_of_end_step, blocks, becomes_targeted.
// See docs/test-plan-079-086.md (Group 4).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// leaves_the_battlefield — Farewell Token (LTB: gain 3). Bounce it off the
// battlefield; the LTB trigger enqueues, resolve it, controller gains 3.
test('EV leaves_the_battlefield fires on bounce (Farewell Token +3)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const token = await s.spawnCreature('A', 'Farewell Token Test')
    const before = await s.lifeOf('A')

    await s.as('A').putOnStack('bounce_creature', { target_card_id: token })
    await s.resolveStack() // bounce -> leaves_the_battlefield trigger enqueued
    await s.resolveStack() // gain 3

    assert.equal(await s.zoneOf(token), 'hand')
    assert.equal(await s.lifeOf('A'), before + 3)
  })
})

// beginning_of_draw_step — Morning Insight (draw a card) on the active player's
// draw step. Driven by the turn-step detector on a step change.
test('EV beginning_of_draw_step fires (Morning Insight draws)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawnCreature('A', 'Morning Insight Test')
    await s.spawn('A', 'Air Elemental Test', 'library')
    await s.spawn('A', 'Deathtouch Viper Test', 'library')
    const handBefore = await s.zoneCount('A', 'hand')

    await s.setTurn({ phase: 'beginning', step: 'draw', active: 'A', priority: 'A' })
    await s.resolveStack() // the draw trigger

    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 1)
  })
})

// beginning_of_end_step — Dawn Tithe (gain 1) on the active player's end step.
test('EV beginning_of_end_step fires (Dawn Tithe +1)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawnCreature('A', 'Dawn Tithe Test')
    const before = await s.lifeOf('A')

    await s.setTurn({ phase: 'ending', step: 'end', active: 'A', priority: 'A' })
    await s.resolveStack()

    assert.equal(await s.lifeOf('A'), before + 1)
  })
})

// blocks — Vengeful Wall (blocks: 1 dmg to each opponent). B blocks A's attacker
// with the Wall; the blocks trigger hits A.
test('EV blocks fires (Vengeful Wall pings the attacker controller)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const attacker = await s.spawnCreature('A', 'Parting Gift Test') // ground, no flying
    const wall = await s.spawnCreature('B', 'Vengeful Wall Test')
    const aBefore = await s.lifeOf('A')

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(attacker, 'B')

    await s.setTurn({ phase: 'combat', step: 'declare_blockers', active: 'A', priority: 'B' })
    await s.as('B').declareBlocker(wall, attacker) // -> blocks trigger enqueued
    await s.resolveStack() // 1 damage to each opponent (A)

    assert.equal(await s.lifeOf('A'), aBefore - 1)
  })
})

// becomes_targeted — Spiteful Sentry (draw when targeted). A targets it with a
// spell; the trigger lands ABOVE the targeting spell (resolves first), B draws,
// then the spell resolves. No infinite loop.
test('EV becomes_targeted fires and lands above the targeting spell', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const sentry = await s.spawnCreature('B', 'Spiteful Sentry Test')
    await s.spawn('B', 'Air Elemental Test', 'library') // something to draw
    const bHandBefore = await s.zoneCount('B', 'hand')

    await s.as('A').putOnStack('tap_creature', { target_card_id: sentry })

    // becomes_targeted trigger sits on top of the targeting spell.
    const top = await s.topStackItem()
    assert.equal(top?.action_type, 'triggered_ability')

    await s.resolveStack() // B draws
    await s.resolveStack() // tap resolves

    assert.equal(await s.zoneCount('B', 'hand'), bHandBefore + 1)
    assert.equal((await s.cardState(sentry)).is_tapped, true)
  })
})
