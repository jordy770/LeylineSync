// Phase 1, slice 11 — sacrifice and return_from_graveyard (raise dead /
// reanimate). Both ride the shared pending-decision machinery via
// apply_trigger_effects park/resume, cast here as untargeted spell_effect
// programs (the same path triggered abilities use). Mirrors more-decisions.test.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// SAC1 — "you sacrifice": the caster chooses among their own creatures.
test('SAC1 sacrifice (you) sends the chosen creature to its graveyard', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const keep = await s.spawnCreature('A', 'Air Elemental Test')
    const doomed = await s.spawnCreature('A', 'Deathtouch Viper Test')

    await s.as('A').castSpellEffect([{ type: 'sacrifice', who: 'you', count: 1 }])
    const res = (await s.as('A').resolveStack()) as Record<string, unknown>
    assert.equal(res.awaiting_decision, true)

    const decision = await s.pendingDecision()
    assert.equal(decision?.decision_type, 'sacrifice')
    assert.equal(decision?.deciding_player_id, s.playerId('A'))
    assert.equal((decision?.options as unknown[]).length, 2) // both A creatures eligible

    await s.as('A').submitDecision(decision!.id, { chosen: [doomed] })

    const doomedState = await s.cardState(doomed)
    assert.equal(doomedState.zone, 'graveyard')
    assert.equal(doomedState.controller_player_id, s.playerId('A')) // owned, not controlled
    assert.equal(await s.zoneOf(keep), 'battlefield')
  })
})

// SAC2 — "opponent sacrifices" (edict): the decision lands on the opponent.
test('SAC2 sacrifice (opponent) makes the opponent sacrifice', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Air Elemental Test') // A's own creature is not eligible
    const victim = await s.spawnCreature('B', 'Deathtouch Viper Test')

    await s.as('A').castSpellEffect([{ type: 'sacrifice', who: 'opponent', count: 1 }])
    await s.as('A').resolveStack()

    const decision = await s.pendingDecision()
    assert.equal(decision?.decision_type, 'sacrifice')
    assert.equal(decision?.deciding_player_id, s.playerId('B')) // B chooses
    assert.equal((decision?.options as unknown[]).length, 1) // only B's creature

    await s.as('B').submitDecision(decision!.id, { chosen: [victim] })
    assert.equal(await s.zoneOf(victim), 'graveyard')
  })
})

// SAC3 — an edict with no eligible creatures just resumes (no decision, no lock).
test('SAC3 sacrifice with no eligible creature resolves cleanly', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    // B controls nothing → the edict finds no creature.
    const item = await s.as('A').castSpellEffect([{ type: 'sacrifice', who: 'opponent', count: 1 }])
    const res = (await s.as('A').resolveStack()) as Record<string, unknown>

    assert.notEqual(res.awaiting_decision, true)
    assert.equal(await s.pendingDecision(), null)
    assert.equal(await s.stackStatus(item.id), 'resolved')
  })
})

// RG1 — return_from_graveyard to hand (Raise Dead).
test('RG1 return_from_graveyard to hand', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const dead = await s.spawn('A', 'Air Elemental Test', 'graveyard')

    await s.as('A').castSpellEffect([{ type: 'return_from_graveyard', to: 'hand', count: 1 }])
    const res = (await s.as('A').resolveStack()) as Record<string, unknown>
    assert.equal(res.awaiting_decision, true)

    const decision = await s.pendingDecision()
    assert.equal(decision?.decision_type, 'return_from_graveyard')
    assert.equal((decision?.options as unknown[]).length, 1)

    await s.as('A').submitDecision(decision!.id, { chosen: [dead] })
    assert.equal(await s.zoneOf(dead), 'hand')
  })
})

// RG2 — return_from_graveyard to battlefield (Reanimate): untapped, controlled by owner.
test('RG2 return_from_graveyard to battlefield reanimates', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const dead = await s.spawn('A', 'Air Elemental Test', 'graveyard')

    await s.as('A').castSpellEffect([{ type: 'return_from_graveyard', to: 'battlefield', count: 1 }])
    await s.as('A').resolveStack()
    const decision = await s.pendingDecision()
    await s.as('A').submitDecision(decision!.id, { chosen: [dead] })

    const st = await s.cardState(dead)
    assert.equal(st.zone, 'battlefield')
    assert.equal(st.controller_player_id, s.playerId('A'))
    assert.equal(st.is_tapped, false)
  })
})

// RG3 — the default filter offers creatures only (a graveyard instant is skipped).
test('RG3 return_from_graveyard offers creatures only by default', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const creature = await s.spawn('A', 'Air Elemental Test', 'graveyard')
    await s.spawn('A', 'Doom Blade Test', 'graveyard') // Instant — not offered

    await s.as('A').castSpellEffect([{ type: 'return_from_graveyard', to: 'hand', count: 1 }])
    await s.as('A').resolveStack()
    const decision = await s.pendingDecision()
    assert.equal((decision?.options as { game_card_id: string }[]).length, 1)
    assert.equal((decision?.options as { game_card_id: string }[])[0].game_card_id, creature)
  })
})

// ME1 — each_opponent edict: every opponent sacrifices in turn (a decision chain).
test('ME1 sacrifice (each_opponent) chains a decision per opponent', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 3)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const aKeep = await s.spawnCreature('A', 'Air Elemental Test') // controller is unaffected
    const bCre = await s.spawnCreature('B', 'Deathtouch Viper Test')
    const cCre = await s.spawnCreature('C', 'Deathtouch Viper Test')

    const item = await s.as('A').castSpellEffect([{ type: 'sacrifice', who: 'each_opponent', count: 1 }])
    const res = (await s.as('A').resolveStack()) as Record<string, unknown>
    assert.equal(res.awaiting_decision, true)

    // First opponent (seat order): B.
    let d = await s.pendingDecision()
    assert.equal(d?.decision_type, 'sacrifice')
    assert.equal(d?.deciding_player_id, s.playerId('B'))
    await s.as('B').submitDecision(d!.id, { chosen: [bCre] })

    // The chain parks the next opponent: C.
    d = await s.pendingDecision()
    assert.equal(d?.deciding_player_id, s.playerId('C'))
    await s.as('C').submitDecision(d!.id, { chosen: [cCre] })

    assert.equal(await s.zoneOf(bCre), 'graveyard')
    assert.equal(await s.zoneOf(cCre), 'graveyard')
    assert.equal(await s.zoneOf(aKeep), 'battlefield') // controller keeps theirs
    assert.equal(await s.stackStatus(item.id), 'resolved')
  })
})

// ME2 — an opponent with no eligible creature is skipped (here the last in the chain).
test('ME2 each_opponent skips an opponent with nothing to sacrifice', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 3)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bCre = await s.spawnCreature('B', 'Deathtouch Viper Test')
    // C controls nothing.

    const item = await s.as('A').castSpellEffect([{ type: 'sacrifice', who: 'each_opponent', count: 1 }])
    await s.as('A').resolveStack()

    const d = await s.pendingDecision()
    assert.equal(d?.deciding_player_id, s.playerId('B'))
    await s.as('B').submitDecision(d!.id, { chosen: [bCre] })

    assert.equal(await s.pendingDecision(), null) // C is skipped — no decision
    assert.equal(await s.zoneOf(bCre), 'graveyard')
    assert.equal(await s.stackStatus(item.id), 'resolved')
  })
})

// ME3 — the skip also works on the FIRST park (first opponent has no creature).
test('ME3 each_opponent skips an empty first opponent', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 3)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    // B controls nothing; only C has a creature.
    const cCre = await s.spawnCreature('C', 'Deathtouch Viper Test')

    const item = await s.as('A').castSpellEffect([{ type: 'sacrifice', who: 'each_opponent', count: 1 }])
    await s.as('A').resolveStack()

    const d = await s.pendingDecision()
    assert.equal(d?.deciding_player_id, s.playerId('C')) // B skipped on the initial park
    await s.as('C').submitDecision(d!.id, { chosen: [cCre] })

    assert.equal(await s.zoneOf(cCre), 'graveyard')
    assert.equal(await s.stackStatus(item.id), 'resolved')
  })
})
