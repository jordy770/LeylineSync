// Observed Stasis / pacify (mig 303): an Aura that gives the enchanted creature
// cant_attack + cant_block continuous effects, so it can neither attack nor
// block while enchanted. (The "loses all abilities" clause and the ETB draw are
// not modelled.)

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// OBS1 — an enchanted creature can't attack.
test('OBS1 a creature enchanted by the pacify Aura cannot attack', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const victim = await s.spawnCreature('B', 'Air Elemental Test')
    const aura = await s.spawn('A', 'Pacify Aura Test', 'hand')

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { U: 1, C: 1 })
    await s.as('A').castPermanent(aura, { target: victim })
    await s.as('A').resolveStack() // Aura attaches; cant_attack/cant_block register

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'B', priority: 'B' })
    await assert.rejects(() => s.as('B').declareAttacker(victim, 'A'))
  })
})

// OBS2 — an enchanted creature can't block.
test('OBS2 a creature enchanted by the pacify Aura cannot block', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const victim = await s.spawnCreature('B', 'Air Elemental Test')
    const attacker = await s.spawnCreature('A', 'Air Elemental Test')
    const aura = await s.spawn('A', 'Pacify Aura Test', 'hand')

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { U: 1, C: 1 })
    await s.as('A').castPermanent(aura, { target: victim })
    await s.as('A').resolveStack()

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(attacker, 'B')
    await s.setTurn({ phase: 'combat', step: 'declare_blockers', active: 'A', priority: 'B' })
    await assert.rejects(() => s.as('B').declareBlocker(victim, attacker))
  })
})
