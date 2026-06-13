// Adventure mechanic (mig 295): casting the adventure half (cast_spell_effect
// with p_adventure) resolves the adventure's spell effect and exiles the card
// with a non-expiring play_from_exile permission, so the creature face can be
// cast from exile afterwards.
//
// Adventurer Test: adventure "Quest Test" creates a Spirit Token; the 2/2
// creature can then be cast from exile.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// ADV1 — cast the adventure: effect resolves, card is exiled (not graveyard).
test('ADV1 casting the adventure resolves its effect and exiles the card', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const card = await s.spawn('A', 'Adventurer Test', 'hand')

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { U: 1 })
    const spiritsBefore = await s.zoneCount('A', 'battlefield')

    await s.as('A').castSpellEffect([{ type: 'create_token', token: 'Spirit Token', count: 1 }], card, null, null, true)
    await s.as('A').resolveStack()

    assert.equal((await s.cardState(card)).zone, 'exile')              // exiled, not graveyard
    assert.equal(await s.zoneCount('A', 'battlefield'), spiritsBefore + 1) // Spirit Token made
  })
})

// ADV2 — the creature face can then be cast from exile onto the battlefield.
test('ADV2 the creature face casts from exile', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const card = await s.spawn('A', 'Adventurer Test', 'hand')

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { U: 1 })
    await s.as('A').castSpellEffect([{ type: 'create_token', token: 'Spirit Token', count: 1 }], card, null, null, true)
    await s.as('A').resolveStack()
    assert.equal((await s.cardState(card)).zone, 'exile')

    // Now cast the creature from exile (permission was granted on the adventure).
    await s.as('A').castPermanent(card)
    await s.as('A').resolveStack()
    assert.equal((await s.cardState(card)).zone, 'battlefield')
  })
})
