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

// ADV3 — a permanent-targeted adventure (destroy + lose-life rider) resolves via
// cast_spell_effect's baked target, and the source is exiled.
test('ADV3 targeted-destroy adventure hits its target and exiles the source', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const rider = await s.spawn('A', 'Adventurer Slayer Test', 'hand')
    const victim = await s.spawnCreature('B', 'Air Elemental Test')

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { B: 1, C: 1 })
    const lifeBefore = await s.lifeOf('A')

    await s.as('A').castSpellEffect(
      [{ type: 'destroy', target_type: 'creature' }, { type: 'lose_life', amount: 2, recipient: 'controller' }],
      rider, null, victim, true,
    )
    await s.as('A').resolveStack()

    assert.notEqual((await s.cardState(victim)).zone, 'battlefield') // destroyed
    assert.equal(await s.lifeOf('A'), lifeBefore - 2)                // rider
    assert.equal((await s.cardState(rider)).zone, 'exile')          // source exiled
  })
})

// ADV4 — a counter adventure (stack-targeted) routes through put_action_on_stack
// and still exiles the source with the play permission (mig 296).
test('ADV4 counter adventure exiles the source', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const counterer = await s.spawn('A', 'Adventurer Counter Test', 'hand')
    const bSpell = await s.spawn('B', 'Spellcraft Spark Test', 'hand')

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'B', priority: 'B' })
    await s.setMana('B', { R: 1 })
    const cast = await s.as('B').castSpellEffect([{ type: 'draw', amount: 1, recipient: 'controller' }], bSpell)

    // Priority passes to A, who responds with the adventure (counter) half.
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'B', priority: 'A' })
    await s.as('A').putOnStack('counter_spell', { target_stack_item_id: cast.id, adventure: true }, counterer)
    await s.as('A').resolveStack()

    assert.equal((await s.cardState(counterer)).zone, 'exile') // exiled via the adventure path, not graveyard
  })
})
