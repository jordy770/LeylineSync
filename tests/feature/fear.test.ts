// Fear keyword (mig 338). Cover of Darkness: "As this enters, choose a creature
// type. Creatures of the chosen type have fear" — they can be blocked only by
// artifact and/or black creatures. Built on the choose_creature_type persistent
// anthem (mig 337): the chosen type registers a 'fear' continuous effect.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// Spawn a Vampire attacker, resolve Cover of Darkness choosing Vampire (giving the
// Vampire fear), then advance to declare-blockers with the Vampire attacking B.
async function vampireWithFearAttacking(s: Scenario): Promise<string> {
  const attacker = await s.spawnCreature('A', 'Vampire Bear Test') // 2/2 Vampire
  await s.spawn('A', 'Cover of Darkness Test', 'battlefield') // ETB: choose a type
  await s.as('A').resolveStack()
  const d = await s.pendingDecision()
  await s.as('A').submitDecision(d!.id, { type: 'Vampire' }) // Vampires gain fear

  await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
  await s.as('A').declareAttacker(attacker, 'B')
  await s.setTurn({ phase: 'combat', step: 'declare_blockers', active: 'A', priority: 'B' })
  return attacker
}

// FR1 — a non-artifact, non-black blocker (red) cannot block a creature with fear.
test('FR1 an off-colour non-artifact blocker is rejected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const attacker = await vampireWithFearAttacking(s)
    const blocker = await s.spawnCreature('B', 'Red Wall Test') // red, non-artifact
    await assert.rejects(() => s.as('B').declareBlocker(blocker, attacker), /fear/)
  })
})

// FR2 — a black creature may block a creature with fear.
test('FR2 a black creature may block fear', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const attacker = await vampireWithFearAttacking(s)
    const blocker = await s.spawnCreature('B', 'Black Wall Test') // {B}
    await s.as('B').declareBlocker(blocker, attacker) // allowed
  })
})

// FR3 — an artifact creature may block a creature with fear.
test('FR3 an artifact creature may block fear', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const attacker = await vampireWithFearAttacking(s)
    const blocker = await s.spawnCreature('B', 'Artifact Wall Test') // artifact
    await s.as('B').declareBlocker(blocker, attacker) // allowed
  })
})

// FR4 — control: a creature NOT of the chosen type has no fear, so any blocker works.
test('FR4 a non-chosen-type attacker has no fear', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const attacker = await s.spawnCreature('A', 'Grave Shambler Test') // Zombie, not chosen
    await s.spawn('A', 'Cover of Darkness Test', 'battlefield')
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { type: 'Vampire' }) // Vampires gain fear, not Zombies

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(attacker, 'B')
    await s.setTurn({ phase: 'combat', step: 'declare_blockers', active: 'A', priority: 'B' })
    const blocker = await s.spawnCreature('B', 'Red Wall Test') // red, would be illegal vs fear
    await s.as('B').declareBlocker(blocker, attacker) // allowed — no fear
  })
})
