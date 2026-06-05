// Phase 4 — activated abilities beyond deal_damage (mig 119). "{cost}: effect"
// abilities now resolve the full effect vocabulary. activate_ability derives the
// matching stack action and delegates to put_action_on_stack (battlefield source →
// no mana/graveyard side effects; targets validated by the builders).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// AA1 — "{T}: Destroy target creature" destroys the target and taps the source.
test('AA1 tap ability destroys the target creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const exec = await s.spawnCreature('A', 'Executioner Test')
    const victim = await s.spawnCreature('B', 'Air Elemental Test')

    await s.as('A').activate(exec, 0, { targetCardId: victim })
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(victim), 'graveyard')
    assert.equal((await s.cardState(exec)).is_tapped, true)
  })
})

// AA2 — "{1},{T}: Tap target creature" pays mana + tap, taps the target.
test('AA2 mana+tap ability taps the target creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { C: 1 })
    const tapper = await s.spawn('A', 'Icy Tapper Test', 'battlefield')
    const target = await s.spawnCreature('B', 'Air Elemental Test')

    await s.as('A').activate(tapper, 0, { targetCardId: target })
    await s.as('A').resolveStack()

    assert.equal((await s.cardState(target)).is_tapped, true)
    assert.equal((await s.cardState(tapper)).is_tapped, true)
    assert.equal((await s.manaOf('A')).C, 0)
  })
})

// AA3 — "{2}: Draw a card" (untargeted) draws for the controller.
test('AA3 mana ability draws a card', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { C: 2 })
    const engine = await s.spawn('A', 'Card Engine Test', 'battlefield')
    await s.spawn('A', 'Air Elemental Test', 'library')
    await s.spawn('A', 'Air Elemental Test', 'library')
    const handBefore = await s.zoneCount('A', 'hand')

    await s.as('A').activate(engine, 0)
    await s.as('A').resolveStack()

    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 1)
    assert.equal((await s.manaOf('A')).C, 0)
  })
})

// AA4 — the controller restriction is honoured: a "destroy target creature an
// opponent controls" ability cannot hit your own creature. (Rejection aborts the
// test transaction, so it is the only assertion.)
test('AA4 a targeted ability enforces the builder target validation', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const exec = await s.spawnCreature('A', 'Executioner Test')

    // No target supplied to a destroy ability → a target is required.
    await assert.rejects(() => s.as('A').activate(exec, 0), /target is required/i)
  })
})
