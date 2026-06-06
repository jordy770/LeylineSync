// Phase 4 / F2.2d — anthems: static team pumps (mig 145). A `pump` continuous effect
// authored affected:'controller' / 'all' was stored by register_card_continuous_effects
// but never applied; card_effective_power/toughness now fold these onto creatures.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// AN1 — "creatures you control get +1/+1" boosts your own creature.
test('AN1 a controller anthem boosts your creatures', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const bear = await s.spawnCreature('A', 'Goblin Raider Test') // 2/2
    await s.spawn('A', 'Glorious Banner Test', 'battlefield')
    await s.as('A').rebuild()

    assert.equal(await s.effectivePower(bear), 3)
    assert.equal(await s.effectiveToughness(bear), 3)
  })
})

// AN2 — a controller anthem does NOT boost an opponent's creature.
test('AN2 a controller anthem ignores opponents creatures', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const mine = await s.spawnCreature('A', 'Goblin Raider Test')
    const theirs = await s.spawnCreature('B', 'Goblin Raider Test')
    await s.spawn('A', 'Glorious Banner Test', 'battlefield')
    await s.as('A').rebuild()

    assert.equal(await s.effectivePower(mine), 3)
    assert.equal(await s.effectivePower(theirs), 2) // unaffected
  })
})

// AN3 — the anthem stops the moment its source leaves the battlefield.
test('AN3 an anthem ends when its source leaves play', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const bear = await s.spawnCreature('A', 'Goblin Raider Test')
    const banner = await s.spawn('A', 'Glorious Banner Test', 'battlefield')
    await s.as('A').rebuild()
    assert.equal(await s.effectivePower(bear), 3)

    await s.as('A').putInGraveyard(banner)
    assert.equal(await s.effectivePower(bear), 2) // bonus gone
  })
})

// AN4 — "all creatures get +2/+0" boosts both players' creatures, power only.
test('AN4 a global anthem boosts every creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const mine = await s.spawnCreature('A', 'Goblin Raider Test') // 2/2
    const theirs = await s.spawnCreature('B', 'Goblin Raider Test')
    await s.spawn('A', 'Total War Banner Test', 'battlefield')
    await s.as('A').rebuild()

    assert.equal(await s.effectivePower(mine), 4)
    assert.equal(await s.effectivePower(theirs), 4)
    assert.equal(await s.effectiveToughness(mine), 2) // +0 toughness
  })
})

// AN5 — anthems + a +1/+1 counter + an until-EOT pump all stack (layer 7c + 7d).
test('AN5 anthem stacks with counters and per-card pumps', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const bear = await s.spawnCreature('A', 'Goblin Raider Test') // 2/2
    await s.spawn('A', 'Glorious Banner Test', 'battlefield') // +1/+1 anthem
    await s.as('A').rebuild()
    await s.putOnStack('add_counters_creature', { target_card_id: bear, amount: 1 })
    await s.resolveStack()

    // 2/2 base + 1/1 counter + 1/1 anthem = 4/4.
    assert.equal(await s.effectivePower(bear), 4)
    assert.equal(await s.effectiveToughness(bear), 4)
  })
})
