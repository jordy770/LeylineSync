// Conditional effect (mig 192) — "If <count> is at least N, <effects>." A state-
// gated composition primitive: the inner effects run only when a count condition
// (creatures you control / lands / graveyard, optional type) is met. Here:
// "If you control two or more Zombies, each opponent loses 3 life."

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

const DRAIN = [
  {
    type: 'conditional',
    condition: { count: 'creatures_you_control', type_line: 'Zombie', at_least: 2 },
    effects: [{ type: 'lose_life', amount: 3, recipient: 'each_opponent' }],
  },
]

// CO1 — condition met (2 Zombies) → the inner effect fires.
test('CO1 inner effects run when the count condition holds', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Grave Shambler Test') // Zombie #1
    await s.spawnCreature('A', 'Grave Shambler Test') // Zombie #2
    const bLife = await s.lifeOf('B')

    await s.as('A').castSpellEffect(DRAIN)
    await s.as('A').resolveStack()

    assert.equal(await s.lifeOf('B'), bLife - 3)
  })
})

// CO2 — condition NOT met (1 Zombie) → the inner effect is skipped.
test('CO2 inner effects are skipped when the condition fails', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Grave Shambler Test') // only 1 Zombie
    await s.spawnCreature('A', 'Air Elemental Test') // not a Zombie — doesn't count
    const bLife = await s.lifeOf('B')

    await s.as('A').castSpellEffect(DRAIN)
    await s.as('A').resolveStack()

    assert.equal(await s.lifeOf('B'), bLife) // unchanged
  })
})
