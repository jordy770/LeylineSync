// "Sacrifice a creature" activated-ability cost (mig 183). Spark Reaper
// ("{2}{B}, Sacrifice another creature: Draw a card") + Vampiric Rites
// ("{1}{B}, Sacrifice a creature: Draw a card and lose 1 life" — a MULTI-effect
// untargeted ability that resolves via a spell_effect stack item).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// SC1 — Spark Reaper: pay {2}{B} + sacrifice a creature → draw a card.
test('SC1 sacrifice-a-creature cost (single effect) draws', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const reaper = await s.spawnCreature('A', 'Spark Reaper Test')
    const victim = await s.spawnCreature('A', 'Grave Shambler Test')
    await s.spawn('A', 'Air Elemental Test', 'library')
    await s.setMana('A', { B: 1, C: 2 }) // {2}{B}
    const handBefore = await s.zoneCount('A', 'hand')

    await s.as('A').activate(reaper, 0, { targetCardId: victim })
    assert.equal(await s.zoneOf(victim), 'graveyard') // sacrificed as a cost

    await s.as('A').resolveStack()
    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 1)
  })
})

// SC2 — Vampiric Rites: sacrifice a creature → draw a card AND lose 1 life.
test('SC2 sacrifice-a-creature cost (multi effect) draws and loses life', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const rites = await s.spawn('A', 'Vampiric Rites Test', 'battlefield')
    const victim = await s.spawnCreature('A', 'Grave Shambler Test')
    await s.spawn('A', 'Air Elemental Test', 'library')
    await s.setMana('A', { B: 1, C: 1 }) // {1}{B}
    const handBefore = await s.zoneCount('A', 'hand')
    const lifeBefore = await s.lifeOf('A')

    await s.as('A').activate(rites, 0, { targetCardId: victim })
    assert.equal(await s.zoneOf(victim), 'graveyard')

    await s.as('A').resolveStack() // the [draw, lose_life] program resolves
    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 1)
    assert.equal(await s.lifeOf('A'), lifeBefore - 1)
  })
})

// SC3 — the cost requires a creature you control to sacrifice.
test('SC3 activating without a creature to sacrifice is rejected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const reaper = await s.spawnCreature('A', 'Spark Reaper Test')
    await s.setMana('A', { B: 1, C: 2 })

    await assert.rejects(() => s.as('A').activate(reaper, 0), /Choose a creature to sacrifice/)
  })
})
