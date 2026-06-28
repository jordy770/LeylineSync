// Sorin, Imperious Bloodlord — quick-win re-script (no migration). Its +1
// "you may sacrifice a Vampire; if you do, deal 3 and gain 3" now uses the may
// program path (mig 339), so the sacrifice + reflexive payoff actually resolve
// from a loyalty ability. APPROXIMATIONS: "any target" → each opponent; the first
// ability's "if it's a Vampire, +1/+1 counter" rider is omitted.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// SO1 — the +1 sacrifice ability sacrifices a Vampire, drains each opponent 3, gains 3.
test('SO1 the sacrifice loyalty ability resolves (sac + 3 damage + 3 life)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const sorin = await s.spawn('A', 'Sorin Test', 'battlefield')
    const fodder = await s.spawnCreature('A', 'Vampire Bear Test') // a Vampire to sac
    const lifeA = await s.lifeOf('A')
    const lifeB = await s.lifeOf('B')

    await s.as('A').activateLoyalty(sorin, 1) // +1: the sacrifice ability
    await s.as('A').resolveStack() // parks the may (confirm)
    let d = await s.pendingDecision()
    assert.equal(d?.decision_type, 'confirm')
    await s.as('A').submitDecision(d!.id, { confirmed: true }) // enqueues the program

    await s.as('A').resolveStack() // program → parks the sacrifice edict
    d = await s.pendingDecision()
    assert.equal(d?.decision_type, 'sacrifice')
    await s.as('A').submitDecision(d!.id, { chosen: [fodder] })
    while (await s.topStackItem()) await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(fodder), 'graveyard', 'Vampire sacrificed')
    assert.equal(await s.lifeOf('B'), lifeB - 3, 'each opponent took 3')
    assert.equal(await s.lifeOf('A'), lifeA + 3, 'gained 3 life')
  })
})
