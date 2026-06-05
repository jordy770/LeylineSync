// Near-term authoring — player-targeted discard (mig 118). `discard` gains
// who:'you'|'opponent' and random:true. Cast as an untargeted spell_effect program
// (the path Mind Rot / Hymn-style spells use). who:'opponent' makes the opponent
// the deciding player (chosen) or loses random cards (random).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// PD1 — Mind Rot: the OPPONENT chooses which card to discard (decision lands on B).
test('PD1 discard who:opponent prompts the opponent to choose', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const c1 = await s.spawn('B', 'Air Elemental Test', 'hand')
    const c2 = await s.spawn('B', 'Deathtouch Viper Test', 'hand')

    await s.as('A').castSpellEffect([{ type: 'discard', who: 'opponent', count: 1 }])
    const res = (await s.as('A').resolveStack()) as Record<string, unknown>
    assert.equal(res.awaiting_decision, true)

    const d = await s.pendingDecision()
    assert.equal(d?.decision_type, 'choose_cards')
    assert.equal(d?.deciding_player_id, s.playerId('B')) // B chooses
    assert.equal((d?.options as unknown[]).length, 2)

    await s.as('B').submitDecision(d!.id, { chosen: [c1] })
    assert.equal(await s.zoneOf(c1), 'graveyard')
    assert.equal(await s.zoneOf(c2), 'hand')
  })
})

// PD2 — random discard: no decision; N random cards leave the opponent's hand.
test('PD2 discard who:opponent random discards N at random (no decision)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('B', 'Air Elemental Test', 'hand')
    await s.spawn('B', 'Deathtouch Viper Test', 'hand')
    await s.spawn('B', 'Air Elemental Test', 'hand')

    const item = await s.as('A').castSpellEffect([{ type: 'discard', who: 'opponent', count: 2, random: true }])
    const res = (await s.as('A').resolveStack()) as Record<string, unknown>

    assert.notEqual(res.awaiting_decision, true) // resolved with no prompt
    assert.equal(await s.zoneCount('B', 'hand'), 1)
    assert.equal(await s.zoneCount('B', 'graveyard'), 2)
    assert.equal(await s.stackStatus(item.id), 'resolved')
  })
})

// PD3 — default who is 'you': the controller discards (unchanged behaviour).
test('PD3 discard defaults to the controller choosing', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const a1 = await s.spawn('A', 'Air Elemental Test', 'hand')

    await s.as('A').castSpellEffect([{ type: 'discard', count: 1 }])
    await s.as('A').resolveStack()

    const d = await s.pendingDecision()
    assert.equal(d?.deciding_player_id, s.playerId('A')) // controller chooses
    await s.as('A').submitDecision(d!.id, { chosen: [a1] })
    assert.equal(await s.zoneOf(a1), 'graveyard')
  })
})

// PD4 — random caps at the hand size (discard 3 from a 1-card hand → 1 discarded).
test('PD4 random discard caps at the available hand size', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('B', 'Air Elemental Test', 'hand')

    await s.as('A').castSpellEffect([{ type: 'discard', who: 'opponent', count: 3, random: true }])
    await s.as('A').resolveStack()

    assert.equal(await s.zoneCount('B', 'hand'), 0)
    assert.equal(await s.zoneCount('B', 'graveyard'), 1)
  })
})
