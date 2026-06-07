// Count-based dynamic amounts (roadmap Tribal #2). An effect "amount" of
// { count: <source>, … } resolves at apply time to a game-state count relative to the
// controller: creatures_you_control, cards_in_graveyard, devotion to a color.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// CA1 — Gray Merchant: each opponent loses life = your devotion to black, you gain it.
test('CA1 devotion to black drains and gains', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const aBefore = await s.lifeOf('A')
    const bBefore = await s.lifeOf('B')

    await s.spawnCreature('A', 'Gray Merchant Test') // {3}{B}{B} → devotion 2 (itself)
    await s.as('A').resolveStack()

    assert.equal(await s.lifeOf('B'), bBefore - 2) // each opponent loses devotion
    assert.equal(await s.lifeOf('A'), aBefore + 2) // you gain that much
  })
})

// CA2 — devotion counts {B} pips across ALL your permanents (two Gray Merchants = 4).
test('CA2 devotion sums pips across your permanents', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Gray Merchant Test') // already on board: 2 black pips
    const bBefore = await s.lifeOf('B')

    await s.spawnCreature('A', 'Gray Merchant Test') // now 2 on board → devotion 4
    await s.as('A').resolveStack()

    assert.equal(await s.lifeOf('B'), bBefore - 4)
  })
})

// CA3 — Lotleth Giant: damage to each opponent = creature cards in your graveyard.
test('CA3 cards_in_graveyard counts your creature cards', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Grave Shambler Test', 'graveyard')
    await s.spawn('A', 'Grave Shambler Test', 'graveyard')
    await s.spawn('A', 'Grave Shambler Test', 'graveyard') // 3 creatures in your graveyard
    const bBefore = await s.lifeOf('B')

    await s.spawnCreature('A', 'Lotleth Giant Test')
    await s.as('A').resolveStack()

    assert.equal(await s.lifeOf('B'), bBefore - 3)
  })
})

// CA4 — creatures_you_control: draw a card for each creature you control (incl. itself).
test('CA4 creatures_you_control drives draw count', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Grave Shambler Test') // 1 creature already
    await s.spawn('A', 'Air Elemental Test', 'library')
    await s.spawn('A', 'Air Elemental Test', 'library')
    const handBefore = await s.zoneCount('A', 'hand')

    await s.spawnCreature('A', 'Tribal Drummer Test') // now 2 creatures you control → draw 2
    await s.as('A').resolveStack()

    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 2)
  })
})
