// Feed the Swarm (mig 196) — "Destroy target creature or enchantment an opponent
// controls. You lose life equal to that permanent's mana value." A `then` lose_life
// rider whose amount is {mana_value_of:'target'}, resolved by card_mana_value
// (parsed from mana_cost, since there is no CMC column). Removal spells resolve via
// the permanent_effect action, which carries the rider.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

const feed = (target: string) => ({
  kind: 'destroy',
  target_card_id: target,
  target_type: ['creature', 'enchantment'],
  then: [{ type: 'lose_life', amount: { mana_value_of: 'target' } }],
})

// FS1 — destroy a {2}{B}{B} creature (mana value 4); the caster loses 4 life.
test('FS1 destroys a creature and loses life equal to its mana value', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const target = await s.spawnCreature('B', 'Costly Beast Test') // {2}{B}{B} = MV 4
    const lifeBefore = await s.lifeOf('A')

    await s.as('A').putOnStack('permanent_effect', feed(target))
    await s.resolveStack()

    assert.equal(await s.zoneOf(target), 'graveyard') // destroyed
    assert.equal(await s.lifeOf('A'), lifeBefore - 4) // lose its mana value
  })
})

// FS2 — also hits an enchantment; the life loss tracks its (different) mana value.
test('FS2 destroys an enchantment and loses its mana value', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const target = await s.spawn('B', 'Costly Charm Test', 'battlefield') // {1}{U} = MV 2
    const lifeBefore = await s.lifeOf('A')

    await s.as('A').putOnStack('permanent_effect', feed(target))
    await s.resolveStack()

    assert.equal(await s.zoneOf(target), 'graveyard')
    assert.equal(await s.lifeOf('A'), lifeBefore - 2) // its mana value
  })
})
