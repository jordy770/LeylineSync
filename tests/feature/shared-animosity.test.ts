// Shared Animosity (mig 340). "Whenever a creature you control attacks, it gets
// +1/+0 until end of turn for each OTHER attacking creature that shares a creature
// type with it." Uses the creature_attacks watcher (reflexive pump on the
// triggering attacker) and a new shared_type_attackers count that compares
// creature subtypes among all declared attackers (resolved at trigger resolution,
// after every attacker is declared).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function resolveAll(s: Scenario) {
  while (await s.topStackItem()) await s.as('A').resolveStack()
}

// SH1 — three attacking Vampires each get +2/+0 (two other Vampire attackers).
test('SH1 each attacker pumps by the number of other type-sharing attackers', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawn('A', 'Shared Animosity Test', 'battlefield')
    const v1 = await s.spawnCreature('A', 'Vampire Bear Test') // 2/2 Vampire
    const v2 = await s.spawnCreature('A', 'Vampire Bear Test')
    const v3 = await s.spawnCreature('A', 'Vampire Bear Test')

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(v1, 'B')
    await s.as('A').declareAttacker(v2, 'B')
    await s.as('A').declareAttacker(v3, 'B')
    await resolveAll(s)

    assert.equal(await s.effectivePower(v1), 4, 'v1 +2 (two other Vampires)')
    assert.equal(await s.effectivePower(v2), 4)
    assert.equal(await s.effectivePower(v3), 4)
  })
})

// SH2 — a non-sharing attacker gets nothing; Vampires still count only Vampires.
test('SH2 only type-sharing attackers count', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawn('A', 'Shared Animosity Test', 'battlefield')
    const v1 = await s.spawnCreature('A', 'Vampire Bear Test') // Vampire
    const v2 = await s.spawnCreature('A', 'Vampire Bear Test') // Vampire
    const z = await s.spawnCreature('A', 'Grave Shambler Test') // Zombie

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(v1, 'B')
    await s.as('A').declareAttacker(v2, 'B')
    await s.as('A').declareAttacker(z, 'B')
    await resolveAll(s)

    assert.equal(await s.effectivePower(v1), 3, 'one other Vampire')
    assert.equal(await s.effectivePower(v2), 3)
    assert.equal(await s.effectivePower(z), 2, 'Zombie shares with no one → +0')
  })
})

// SH3 — a lone attacker has no other sharing attacker → no pump.
test('SH3 a single attacker gets no pump', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawn('A', 'Shared Animosity Test', 'battlefield')
    const v1 = await s.spawnCreature('A', 'Vampire Bear Test')

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(v1, 'B')
    await resolveAll(s)

    assert.equal(await s.effectivePower(v1), 2)
  })
})
