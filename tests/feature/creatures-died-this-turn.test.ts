// "Creatures that died under your control this turn" count source (mig 193) —
// a turn-stamped tally bumped in put_in_graveyard. Exercised as both a conditional
// condition (Death Drain: "if a creature died this turn…") and a dynamic draw
// amount (Liliana's Standard Bearer: "draw X = creatures died this turn").

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// DT1 — a creature dying under A's control this turn satisfies the conditional.
test('DT1 conditional fires after a creature died this turn', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const mine = await s.spawnCreature('A', 'Grave Shambler Test')
    const bLife = await s.lifeOf('B')

    await s.as('A').putOnStack('destroy_creature', { target_card_id: mine, target_controller: 'any' })
    await s.as('A').resolveStack() // mine dies → A's died-this-turn = 1

    await s.as('A').castSpellEffect([
      { type: 'conditional', condition: { count: 'creatures_died_this_turn', at_least: 1 },
        effects: [{ type: 'lose_life', amount: 2, recipient: 'each_opponent' }] },
    ])
    await s.as('A').resolveStack()

    assert.equal(await s.lifeOf('B'), bLife - 2)
  })
})

// DT2 — with no death this turn, the conditional is skipped.
test('DT2 conditional skipped with no death this turn', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Grave Shambler Test') // alive — no death
    const bLife = await s.lifeOf('B')

    await s.as('A').castSpellEffect([
      { type: 'conditional', condition: { count: 'creatures_died_this_turn', at_least: 1 },
        effects: [{ type: 'lose_life', amount: 2, recipient: 'each_opponent' }] },
    ])
    await s.as('A').resolveStack()

    assert.equal(await s.lifeOf('B'), bLife) // unchanged
  })
})

// DT3 — dynamic draw amount: Standard Bearer draws one card per creature that died
// under your control this turn (two deaths → draw two).
test('DT3 draw amount equals creatures that died this turn', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const c1 = await s.spawnCreature('A', 'Grave Shambler Test')
    const c2 = await s.spawnCreature('A', 'Grave Shambler Test')
    await s.spawn('A', 'Air Elemental Test', 'library')
    await s.spawn('A', 'Deathtouch Viper Test', 'library')

    for (const c of [c1, c2]) {
      await s.as('A').putOnStack('destroy_creature', { target_card_id: c, target_controller: 'any' })
      await s.as('A').resolveStack()
    }
    const handBefore = await s.zoneCount('A', 'hand')

    await s.spawn('A', "Liliana's Standard Bearer Test", 'battlefield') // ETB: draw X
    await s.as('A').resolveStack()

    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 2) // two deaths → two cards
  })
})
