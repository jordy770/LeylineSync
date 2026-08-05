// Madness (mig 434, From Under the Floorboards / Markov Baron) — "If you
// discard this card, discard it into exile. When you do, cast it for its
// madness cost or put it into your graveyard." The new discard_card helper
// intercepts every discard path (chooser picks and the random bulk branches):
// a hand card whose script carries `madness` goes to EXILE with a stack-less
// madness_cast decision for its owner. Submitting {cast:true, x?} pays the
// madness cost and casts from exile — a permanent as a cast_permanent stack
// item, a spell as its madness_effect (X-substituted) program; {cast:false}
// puts it in the graveyard.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

const DISCARD1 = [{ type: 'discard', count: 1 }]

async function discardByChoice(s: Scenario, cardId: string) {
  await s.as('A').castSpellEffect(DISCARD1, null)
  await s.as('A').resolveStack()
  const pick = await s.pendingDecision()
  assert.ok(pick, 'discard chooser parked')
  await s.as('A').submitDecision(pick.id, { chosen: [cardId] })
}

// MD1 — a chosen discard of a madness card exiles it and parks the decision.
test('MD1 discarding a madness card exiles it with a madness decision', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const ritual = await s.spawn('A', 'Madness Ritual Test', 'hand')
    await discardByChoice(s, ritual)

    assert.equal(await s.zoneOf(ritual), 'exile')
    const decision = await s.pendingDecision()
    assert.ok(decision)
    assert.equal(decision.decision_type, 'madness_cast')
    assert.equal(decision.source_stack_item_id, null) // stack-less
  })
})

// MD2 — declining puts the card in the graveyard.
test('MD2 declining madness puts the card in the graveyard', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const ritual = await s.spawn('A', 'Madness Ritual Test', 'hand')
    await discardByChoice(s, ritual)
    const decision = await s.pendingDecision()
    assert.ok(decision)

    await s.as('A').submitDecision(decision.id, { cast: false })
    assert.equal(await s.zoneOf(ritual), 'graveyard')
    assert.equal(await s.pendingCount(), 0)
  })
})

// MD3 — casting for madness pays {X}{B}{B} and runs the X-substituted
// madness_effect program.
test('MD3 madness cast runs the madness_effect with the chosen X', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const ritual = await s.spawn('A', 'Madness Ritual Test', 'hand')
    await discardByChoice(s, ritual)
    const decision = await s.pendingDecision()
    assert.ok(decision)
    const lifeBefore = await s.lifeOf('A')
    await s.setMana('A', { B: 2, C: 2 }) // {X}{B}{B} with X=2

    await s.as('A').submitDecision(decision.id, { cast: true, x: 2 })
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(ritual), 'graveyard') // cast, then resolved
    assert.equal(await s.zoneCount('A', 'battlefield'), 2) // X tokens, not three
    assert.equal(await s.lifeOf('A'), lifeBefore + 2) // gain X life
  })
})

// MD4 — a madness PERMANENT resolves onto the battlefield for its madness cost.
test('MD4 madness cast of a creature puts it on the battlefield', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const vampire = await s.spawn('A', 'Madness Vampire Test', 'hand')
    await discardByChoice(s, vampire)
    const decision = await s.pendingDecision()
    assert.ok(decision)
    await s.setMana('A', { B: 1, C: 1 }) // madness {1}{B}, not the printed {3}{B}

    await s.as('A').submitDecision(decision.id, { cast: true })
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(vampire), 'battlefield')
  })
})

// MD5 — the random (bulk) discard branch triggers madness too.
test('MD5 a random discard also triggers madness', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const ritual = await s.spawn('A', 'Madness Ritual Test', 'hand') // only hand card

    await s.as('A').castSpellEffect([{ type: 'discard', count: 1, random: true }], null)
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(ritual), 'exile')
    const decision = await s.pendingDecision()
    assert.equal(decision?.decision_type, 'madness_cast')
  })
})

// MD6 — a card without madness still discards straight to the graveyard.
test('MD6 a non-madness discard goes to the graveyard as before', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const island = await s.spawn('A', 'Island Test', 'hand')
    await discardByChoice(s, island)
    assert.equal(await s.zoneOf(island), 'graveyard')
    assert.equal(await s.pendingCount(), 0)
  })
})
