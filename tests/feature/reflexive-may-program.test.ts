// Reflexive "when you do" via may + program (mig 339). Ruthless Lawbringer:
// "When this enters, you may sacrifice another creature. When you do, destroy
// target nonland permanent." The may is gated on having ≥2 creatures (so a
// sacrifice is possible); on confirm its inner effects run as a fresh program —
// the sacrifice edict parks first, then destroy_up_to parks its own target pick.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// RL1 — confirm: sacrifice the fodder, then destroy a target nonland permanent.
test('RL1 may→program sacrifices then destroys a nonland permanent', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const fodder = await s.spawnCreature('A', 'Grave Shambler Test') // sac fodder
    const victim = await s.spawnCreature('B', 'Grave Shambler Test') // B's nonland permanent

    await s.spawnCreature('A', 'Lawbringer Test') // ETB: may sacrifice → destroy
    await s.as('A').resolveStack() // ETB resolves → parks the may (confirm)

    let d = await s.pendingDecision()
    assert.equal(d?.decision_type, 'confirm')
    await s.as('A').submitDecision(d!.id, { confirmed: true }) // enqueues the program

    await s.as('A').resolveStack() // program runs → parks the sacrifice edict
    d = await s.pendingDecision()
    assert.equal(d?.decision_type, 'sacrifice')
    await s.as('A').submitDecision(d!.id, { chosen: [fodder] }) // sac the fodder

    d = await s.pendingDecision() // sacrifice resumed the program → destroy pick
    assert.equal(d?.decision_type, 'destroy_pick')
    await s.as('A').submitDecision(d!.id, { chosen: [victim] })

    assert.equal(await s.zoneOf(fodder), 'graveyard', 'fodder sacrificed')
    assert.equal(await s.zoneOf(victim), 'graveyard', "B's permanent destroyed")
  })
})

// RL2 — decline: no sacrifice, no destroy.
test('RL2 declining the may does nothing', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const fodder = await s.spawnCreature('A', 'Grave Shambler Test')
    const victim = await s.spawnCreature('B', 'Grave Shambler Test')

    await s.spawnCreature('A', 'Lawbringer Test')
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { confirmed: false }) // decline

    assert.equal(await s.pendingDecision(), null, 'no further decisions')
    assert.equal(await s.zoneOf(fodder), 'battlefield', 'fodder kept')
    assert.equal(await s.zoneOf(victim), 'battlefield', 'nothing destroyed')
  })
})

// RL3 — gate: with no OTHER creature (only Lawbringer), the may is not offered,
// so there is no free destroy.
test('RL3 the may is not offered without a creature to sacrifice', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const victim = await s.spawnCreature('B', 'Grave Shambler Test')

    await s.spawnCreature('A', 'Lawbringer Test') // A's only creature
    await s.as('A').resolveStack()

    assert.equal(await s.pendingDecision(), null, 'condition gate suppressed the may')
    assert.equal(await s.zoneOf(victim), 'battlefield', 'nothing destroyed')
  })
})
