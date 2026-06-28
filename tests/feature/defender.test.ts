// Defender enforcement (mig 323) — "a creature with defender can't attack."
// declare_attacker rejects a defender creature; a vanilla creature still attacks.
// The Wall Test fixture carries defender as a `continuous_effects` entry (the test
// seeder doesn't populate the cards.keywords column the printed-keyword path reads).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// DF1 — a defender creature cannot be declared as an attacker.
test('DF1 a creature with defender cannot attack', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const wall = await s.spawnCreature('A', 'Wall Test')
    await s.spawnCreature('B', 'Air Elemental Test')
    await s.as('A').rebuild()

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await assert.rejects(() => s.as('A').declareAttacker(wall, 'B'), /defender cannot attack/)
  })
})

// DF2 — a non-defender creature still attacks normally (the gate is specific).
test('DF2 a vanilla creature still attacks alongside a defender on the board', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawnCreature('A', 'Wall Test')                  // can't attack
    const brute = await s.spawnCreature('A', 'Menace Brute Test') // can
    await s.spawnCreature('B', 'Air Elemental Test')
    await s.as('A').rebuild()

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    const assignment = await s.as('A').declareAttacker(brute, 'B')
    assert.ok(assignment, 'the non-defender creature was declared as an attacker')
  })
})
