// Menace enforcement (mig 194) — "can't be blocked except by two or more
// creatures." A creature with menace blocked by exactly one creature makes the
// declare_blockers → combat_damage transition illegal; zero or two+ is fine.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// MN1 — a lone blocker on a menace attacker is illegal (can't leave declare_blockers).
test('MN1 a single blocker on a menace creature is rejected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const attacker = await s.spawnCreature('A', 'Menace Brute Test')
    const b1 = await s.spawnCreature('B', 'Air Elemental Test')
    await s.as('A').rebuild()

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(attacker, 'B')
    await s.setTurn({ phase: 'combat', step: 'declare_blockers', active: 'A', priority: 'B' })
    await s.as('B').declareBlocker(b1, attacker)

    await s.setTurn({ phase: 'combat', step: 'declare_blockers', active: 'A', priority: 'A' })
    await assert.rejects(() => s.as('A').advanceStep(), /two or more creatures/)
  })
})

// MN2 — two blockers is legal.
test('MN2 two blockers on a menace creature is allowed', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const attacker = await s.spawnCreature('A', 'Menace Brute Test')
    const b1 = await s.spawnCreature('B', 'Air Elemental Test')
    const b2 = await s.spawnCreature('B', 'Grave Shambler Test')
    await s.as('A').rebuild()

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(attacker, 'B')
    await s.setTurn({ phase: 'combat', step: 'declare_blockers', active: 'A', priority: 'B' })
    await s.as('B').declareBlocker(b1, attacker)
    await s.as('B').declareBlocker(b2, attacker)

    await s.setTurn({ phase: 'combat', step: 'declare_blockers', active: 'A', priority: 'A' })
    const st = await s.as('A').advanceStep()
    assert.equal(st.step, 'combat_damage') // advanced normally
  })
})

// MN3 — leaving a menace attacker unblocked is fine (menace allows zero blockers).
test('MN3 a menace creature may go unblocked', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const attacker = await s.spawnCreature('A', 'Menace Brute Test')
    await s.spawnCreature('B', 'Air Elemental Test') // available but not assigned
    await s.as('A').rebuild()

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(attacker, 'B')

    await s.setTurn({ phase: 'combat', step: 'declare_blockers', active: 'A', priority: 'A' })
    const st = await s.as('A').advanceStep()
    assert.equal(st.step, 'combat_damage')
  })
})
