// Phase 1, slice 2 — pending-decision machinery + modal "choose one".
// Server-side vertical slice; modes use untargeted actions for now.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

const MODES = [
  { label: 'Gain 3 life', actions: [{ type: 'gain_life', amount: 3 }] },
  { label: 'Each opponent loses 2', actions: [{ type: 'lose_life', amount: 2, recipient: 'each_opponent' }] },
]

// A charm-style modal: one untargeted mode, one that destroys a target creature.
const TARGETED_MODES = [
  { label: 'Gain 3 life', actions: [{ type: 'gain_life', amount: 3 }] },
  { label: 'Destroy target creature', actions: [{ type: 'destroy', target_type: 'creature' }] },
]

// MD1-guard — a modal spell cannot resolve until its mode is chosen.
// (Expected rejection is the LAST action: it aborts the test transaction.)
test('MD1-guard modal spell cannot resolve before the mode is chosen', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    await s.as('A').castModal(MODES, 1)
    const decision = await s.pendingDecision()
    assert.equal(decision?.decision_type, 'choose_mode')

    await assert.rejects(() => s.as('A').resolveStack())
  })
})

// MD1 — happy path: after submit_decision the chosen mode resolves.
test('MD1 modal spell resolves the chosen mode', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const aBefore = await s.lifeOf('A')
    await s.as('A').castModal(MODES, 1)

    const decision = await s.pendingDecision()
    await s.as('A').submitDecision(decision!.id, { chosen: [0] }) // Gain 3 life
    await s.as('A').resolveStack()

    assert.equal(await s.lifeOf('A'), aBefore + 3)
  })
})

// MD2 — the other mode hits the opponent (proves the index actually selects).
test('MD2 choosing the second mode applies that mode', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const bBefore = await s.lifeOf('B')
    await s.as('A').castModal(MODES, 1)
    const decision = await s.pendingDecision()
    await s.as('A').submitDecision(decision!.id, { chosen: [1] }) // each opponent loses 2
    await s.as('A').resolveStack()

    assert.equal(await s.lifeOf('B'), bBefore - 2)
  })
})

// MD3 — validation: an out-of-range mode index is rejected.
test('MD3 submit_decision rejects an out-of-range mode index', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    await s.as('A').castModal(MODES, 1)
    const decision = await s.pendingDecision()
    await assert.rejects(() => s.as('A').submitDecision(decision!.id, { chosen: [5] }))
  })
})

// MD4 — only the deciding player may submit.
test('MD4 a non-deciding player cannot submit the decision', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    await s.as('A').castModal(MODES, 1)
    const decision = await s.pendingDecision()
    await assert.rejects(() => s.as('B').submitDecision(decision!.id, { chosen: [0] }))
  })
})

// MDT1 — choosing a targeted mode + a target destroys that creature.
test('MDT1 targeted mode destroys the chosen creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bear = await s.spawnCreature('B', 'Air Elemental Test')

    await s.as('A').castModal(TARGETED_MODES, 1)
    const decision = await s.pendingDecision()
    await s.as('A').submitDecision(decision!.id, { chosen: [1], target_card_id: bear })
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(bear), 'graveyard')
  })
})

// MDT2 — choosing the untargeted mode of a modal with targeted options needs no target.
test('MDT2 untargeted mode of a targeted modal needs no target', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const aBefore = await s.lifeOf('A')

    await s.as('A').castModal(TARGETED_MODES, 1)
    const decision = await s.pendingDecision()
    await s.as('A').submitDecision(decision!.id, { chosen: [0] }) // gain 3 life, no target
    await s.as('A').resolveStack()

    assert.equal(await s.lifeOf('A'), aBefore + 3)
  })
})

// MDT3 — a targeted mode with no target is rejected.
test('MDT3 a targeted mode requires a target', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('B', 'Air Elemental Test')

    await s.as('A').castModal(TARGETED_MODES, 1)
    const decision = await s.pendingDecision()
    await assert.rejects(() => s.as('A').submitDecision(decision!.id, { chosen: [1] })) // no target_card_id
  })
})
