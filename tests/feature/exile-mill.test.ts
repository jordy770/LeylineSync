// Feature group 083 — exile (spell + targeted trigger) and mill.
// See docs/test-plan-079-086.md (Group 5).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// E1 — Banishing Bolt (spell): exile target creature to the owner's exile zone.
// Exercises apply_creature_effect exile branch via the spell path.
test('E1 exile_creature spell sends the target to exile', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const bear = await s.spawnCreature('B', 'Air Elemental Test')
    await s.as('A').putOnStack('exile_creature', { target_card_id: bear })
    await s.resolveStack()

    const after = await s.cardState(bear)
    assert.equal(after.zone, 'exile')
    assert.equal(after.controller_player_id, after.owner_id)
  })
})

// E2 — Banisher Priest (ETB): exile target creature an opponent controls.
// Targeted-trigger exile + ownership restriction (mirrors Chupacabra, exile zone).
test('E2 targeted ETB exile hits the chosen opponent creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const victim = await s.spawnCreature('B', 'Air Elemental Test')
    await s.spawnCreature('A', 'Banisher Priest Test')

    const trigger = await s.topStackItem()
    assert.equal(trigger?.action_type, 'triggered_ability')

    await s.as('A').chooseTriggerTarget(trigger!.id, victim)
    await s.resolveStack()

    assert.equal(await s.zoneOf(victim), 'exile')
  })
})

// E3 — Grinding Scholar (ETB): each opponent mills three cards (library -> graveyard).
test('E3 mill moves each opponent library cards to graveyard', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    // Stock B's library with 4 cards.
    await s.spawn('B', 'Air Elemental Test', 'library')
    await s.spawn('B', 'Deathtouch Viper Test', 'library')
    await s.spawn('B', 'Silhana Ledgewalker Test', 'library')
    await s.spawn('B', 'Parting Gift Test', 'library')
    const libBefore = await s.zoneCount('B', 'library')
    const gyBefore = await s.zoneCount('B', 'graveyard')

    await s.spawnCreature('A', 'Grinding Scholar Test') // ETB: each opponent mills 3
    await s.resolveStack()

    assert.equal(await s.zoneCount('B', 'library'), libBefore - 3)
    assert.equal(await s.zoneCount('B', 'graveyard'), gyBefore + 3)
  })
})
