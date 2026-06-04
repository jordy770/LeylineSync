// Tier-2 effect: grant_keyword — a targeted trigger gives a creature a keyword
// until end of turn (migration 099). Mirrors the targeted-trigger path
// (TT1) and the until-EOT continuous-effect lifecycle (create_pt_pump).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// GK1 — Windcaller ETB grants flying to a chosen creature you control, and the
// grant lapses at end-of-turn cleanup.
test('GK1 grant_keyword gives flying until end of turn', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const bear = await s.spawnCreature('A', 'Deathtouch Viper Test') // vanilla target (no flying)
    assert.equal(await s.continuousEffectCount(bear, 'flying'), 0)

    await s.spawnCreature('A', 'Windcaller Test') // ETB: target creature you control gains flying

    const trigger = await s.topStackItem()
    assert.equal(trigger?.action_type, 'triggered_ability')

    await s.as('A').chooseTriggerTarget(trigger!.id, bear)
    await s.resolveStack()

    // Granted while on the battlefield.
    assert.equal(await s.continuousEffectCount(bear, 'flying'), 1)

    // Lapses at end-of-turn cleanup (the grant's expires_at_phase/step).
    await s.as('A').expireEffects('ending', 'cleanup')
    assert.equal(await s.continuousEffectCount(bear, 'flying'), 0)
  })
})

// GK2 — controller restriction: "you control" cannot target an opponent's creature.
test('GK2 grant_keyword rejects targeting an opponent creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const oppCreature = await s.spawnCreature('B', 'Air Elemental Test') // illegal target
    await s.spawnCreature('A', 'Deathtouch Viper Test') // legal target so the trigger enqueues
    await s.spawnCreature('A', 'Windcaller Test')

    const trigger = await s.topStackItem()
    assert.equal(trigger?.action_type, 'triggered_ability')

    await assert.rejects(() => s.as('A').chooseTriggerTarget(trigger!.id, oppCreature))
  })
})
