// Bucket-7 slice (mig 440) — "other/another" exclusions + sorcery-only timing:
// - pump_all / grant_keyword_all with exclude_self (End-Raze Forerunners:
//   "OTHER creatures you control get +2/+2 …") — per-creature rows so the
//   source itself stays untouched.
// - Targeted trigger effects with target_filter.exclude_self (Xenagos /
//   Majestic Heliopterus: "ANOTHER target creature you control") — the
//   chooser rejects the trigger's own source.
// - Activated-ability timing 'sorcery' (Orthion: "Activate only as a
//   sorcery") — active player, main phase, empty stack.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// CN1 — the mass pump/grant skips the source itself.
test('CN1 exclude_self mass pump leaves the source untouched', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const other = await s.spawn('A', 'Goblin Raider Test', 'battlefield') // 2/2
    // Spawning onto the battlefield fires the ETB trigger itself.
    const boar = await s.spawn('A', 'Boar Rally Test', 'battlefield') // 5/5
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()

    assert.equal(await s.effectivePower(other), 4) // 2 + 2
    assert.equal(await s.effectivePower(boar), 5) // untouched
    assert.equal(await s.continuousEffectCount(other, 'vigilance'), 1)
    assert.equal(await s.continuousEffectCount(boar, 'vigilance'), 0)
  })
})

// CN2 — the targeted trigger refuses its own source as target...
test('CN2 target_filter.exclude_self rejects the source as target', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const god = await s.spawn('A', 'Revel God Test', 'battlefield')
    await s.spawn('A', 'Goblin Raider Test', 'battlefield')

    await s.as('A').fireTriggers('A', god, ['beginning_of_combat'])
    const item = await s.topStackItem()
    assert.ok(item)
    await assert.rejects(() => s.as('A').chooseTriggerTarget(item.id, god), /own source/i)
  })
})

// CN2b — ...and accepts another creature.
test('CN2b target_filter.exclude_self accepts another creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const god = await s.spawn('A', 'Revel God Test', 'battlefield')
    const other = await s.spawn('A', 'Goblin Raider Test', 'battlefield') // 2/2

    await s.as('A').fireTriggers('A', god, ['beginning_of_combat'])
    const item = await s.topStackItem()
    assert.ok(item)
    await s.as('A').chooseTriggerTarget(item.id, other)
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()

    assert.equal(await s.effectivePower(other), 4) // 2 + 2
    assert.equal(await s.continuousEffectCount(other, 'haste'), 1)
  })
})

// CN3 — a sorcery-only ability is refused off-turn / off-phase...
test('CN3 sorcery-only activation is refused outside your main phase', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const tinker = await s.spawnCreature('A', 'Sorcery Tinker Test')
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await assert.rejects(() => s.as('A').activate(tinker, 0), /sorcery/i)
  })
})

// CN3b — ...and works in your own main phase with an empty stack.
test('CN3b sorcery-only activation works in the main phase', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const tinker = await s.spawnCreature('A', 'Sorcery Tinker Test')
    await s.spawn('A', 'Island Test', 'library')
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    await s.as('A').activate(tinker, 0)
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()

    assert.equal(await s.zoneCount('A', 'hand'), 1)
  })
})
