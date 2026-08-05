// Per-opponent amounts & targets (mig 435, bucket 3) —
// - times_opponents (Exsanguinate / Malakir Bloodwitch): "you gain life equal
//   to the life lost this way" = base amount × number of opponents.
// - choose_player drains (Sanguine Bond / Vito): "target opponent loses that
//   much life" — the lifegain trigger parks a choose_player decision whose
//   nested effects get event_amount PRE-resolved (the submit-time apply has no
//   event payload anymore).
// - opponents_with_more_lands (Priest of the Blessed Graf): a new count for
//   dynamic token numbers, resolved per end-step trigger.
// - shuffle_graveyards_into_libraries (Struggle // Survive's aftermath half,
//   modeled as flashback + flashback_effect): each player shuffles their
//   graveyard into their library.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

const DRAIN_X = [
  { type: 'lose_life', amount: 'X', recipient: 'each_opponent' },
  { type: 'gain_life', amount: 'X', recipient: 'controller', times_opponents: true },
]

// PO1 — with two opponents, X=3 drains both and gains 3×2.
test('PO1 times_opponents multiplies the gain by the opponent count', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 3)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Drain All Test', 'hand')
    const lifeA = await s.lifeOf('A')
    const lifeB = await s.lifeOf('B')
    const lifeC = await s.lifeOf('C')
    await s.setMana('A', { B: 2, C: 3 })

    await s.as('A').castSpellEffect(DRAIN_X, spell, 3)
    await s.as('A').resolveStack()

    assert.equal(await s.lifeOf('B'), lifeB - 3)
    assert.equal(await s.lifeOf('C'), lifeC - 3)
    assert.equal(await s.lifeOf('A'), lifeA + 6) // 3 × 2 opponents
  })
})

// PO2 — the lifegain trigger drains ONE chosen opponent for the event amount.
test('PO2 choose_player drain hits only the chosen opponent', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 3)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Bond Drain Test', 'battlefield')
    const lifeB = await s.lifeOf('B')
    const lifeC = await s.lifeOf('C')

    await s.as('A').castSpellEffect([{ type: 'gain_life', amount: 3 }], null)
    await s.as('A').resolveStack() // gain 3 → lifegain trigger enqueued
    await s.as('A').resolveStack() // resolve the trigger → choose_player parks

    const decision = await s.pendingDecision()
    assert.ok(decision)
    assert.equal(decision.decision_type, 'choose_player')
    await s.as('A').submitDecision(decision.id, { player_id: s.playerId('C') })

    assert.equal(await s.lifeOf('C'), lifeC - 3) // event amount, pre-resolved
    assert.equal(await s.lifeOf('B'), lifeB) // untouched
  })
})

// PO3 — token count equals the number of opponents with more lands than you.
test('PO3 opponents_with_more_lands counts correctly', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 3)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const priest = await s.spawn('A', 'Graf Priest Test', 'battlefield')
    await s.spawn('A', 'Island Test', 'battlefield')
    await s.spawn('B', 'Island Test', 'battlefield')
    await s.spawn('B', 'Island Test', 'battlefield') // B: 2 lands > A: 1
    // C: 0 lands — not more than A.
    const before = await s.zoneCount('A', 'battlefield')

    await s.as('A').fireTriggers('A', priest, ['end_step'])
    await s.as('A').resolveStack()

    assert.equal(await s.zoneCount('A', 'battlefield'), before + 1) // exactly one Spirit
  })
})

// PO4 — the aftermath half (flashback_effect) shuffles every graveyard away.
test('PO4 shuffle_graveyards_into_libraries empties every graveyard', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Aftermath Survive Test', 'graveyard')
    await s.spawn('A', 'Goblin Raider Test', 'graveyard')
    await s.spawn('B', 'Air Elemental Test', 'graveyard')
    await s.setMana('A', { G: 1, C: 1 }) // flashback {1}{G}

    await s.as('A').castSpellEffect([{ type: 'draw', amount: 0 }], spell)
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(spell), 'exile') // flashback exiles the spell
    assert.equal(await s.zoneCount('A', 'graveyard'), 0)
    assert.equal(await s.zoneCount('B', 'graveyard'), 0)
    assert.equal(await s.zoneCount('A', 'library'), 1)
    assert.equal(await s.zoneCount('B', 'library'), 1)
  })
})
