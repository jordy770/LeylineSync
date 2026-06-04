// Phase 1, slice 9 — more resolution-time choices: tutor (search_library),
// discard (choose_cards), and optional "may" (confirm). All ride the shared
// pending-decision machinery via apply_trigger_effects park/resume.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function fillLibrary(s: Scenario, n: number): Promise<string[]> {
  for (let i = 0; i < n; i++) await s.spawn('A', 'Air Elemental Test', 'library')
  return s.libraryIds('A')
}

// TUT1 — search_library: pick a creature → it goes to hand, library shuffles.
test('TUT1 tutor moves the chosen card to hand and shuffles', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const lib = await fillLibrary(s, 3) // creatures
    const handBefore = await s.zoneCount('A', 'hand')

    await s.spawnCreature('A', 'Tutor Seer Test')
    const res = (await s.as('A').resolveStack()) as Record<string, unknown>
    assert.equal(res.awaiting_decision, true)

    const decision = await s.pendingDecision()
    assert.equal(decision?.decision_type, 'search_library')
    assert.equal((decision?.options as unknown[]).length, 3) // all 3 creatures matched

    const pick = lib[1]
    await s.as('A').submitDecision(decision!.id, { chosen: [pick] })

    assert.equal(await s.zoneOf(pick), 'hand')
    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 1)
    assert.equal(await s.zoneCount('A', 'library'), lib.length - 1)
  })
})

// TUT2 — searching for nothing (you may fail to find) just resumes.
test('TUT2 tutor may decline to find', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await fillLibrary(s, 2)

    await s.spawnCreature('A', 'Tutor Seer Test')
    await s.as('A').resolveStack()
    const decision = await s.pendingDecision()
    await s.as('A').submitDecision(decision!.id, { chosen: [] }) // fail to find

    assert.equal(await s.zoneCount('A', 'library'), 2)
  })
})

// DIS1 — discard: choose a hand card → graveyard.
test('DIS1 discard moves the chosen hand card to the graveyard', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const h1 = await s.spawn('A', 'Air Elemental Test', 'hand')
    await s.spawn('A', 'Air Elemental Test', 'hand')

    await s.spawnCreature('A', 'Discard Seer Test')
    await s.as('A').resolveStack()
    const decision = await s.pendingDecision()
    assert.equal(decision?.decision_type, 'choose_cards')

    await s.as('A').submitDecision(decision!.id, { chosen: [h1] })
    assert.equal(await s.zoneOf(h1), 'graveyard')
  })
})

// MAY1 — confirm yes runs the inner effect.
test('MAY1 may → yes applies the inner effect', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const before = await s.lifeOf('A')

    await s.spawnCreature('A', 'May Gain Seer Test')
    await s.as('A').resolveStack()
    const decision = await s.pendingDecision()
    assert.equal(decision?.decision_type, 'confirm')

    await s.as('A').submitDecision(decision!.id, { confirmed: true })
    assert.equal(await s.lifeOf('A'), before + 3)
  })
})

// MAY2 — confirm no skips the inner effect.
test('MAY2 may → no skips the inner effect', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const before = await s.lifeOf('A')

    await s.spawnCreature('A', 'May Gain Seer Test')
    await s.as('A').resolveStack()
    const decision = await s.pendingDecision()
    await s.as('A').submitDecision(decision!.id, { confirmed: false })

    assert.equal(await s.lifeOf('A'), before)
  })
})

// CP1 — choose_player: the chosen opponent takes the inner effect.
test('CP1 choose_player applies the inner effect to the chosen player', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bBefore = await s.lifeOf('B')

    await s.spawnCreature('A', 'Choose Foe Seer Test')
    await s.as('A').resolveStack()
    const decision = await s.pendingDecision()
    assert.equal(decision?.decision_type, 'choose_player')
    assert.equal((decision?.options as { player_id: string }[]).length, 1) // opponent filter → only B

    await s.as('A').submitDecision(decision!.id, { player_id: s.players.B })
    assert.equal(await s.lifeOf('B'), bBefore - 3)
  })
})

// CP2 — a player that wasn't offered is rejected.
test('CP2 choose_player rejects a player not offered', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    await s.spawnCreature('A', 'Choose Foe Seer Test')
    await s.as('A').resolveStack()
    const decision = await s.pendingDecision()
    // A is the controller; with filter 'opponent' only B was offered.
    await assert.rejects(() => s.as('A').submitDecision(decision!.id, { player_id: s.players.A }))
  })
})
