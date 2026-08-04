// Basic landcycling (mig 427) — "{2}, Discard this card: Search your library
// for a basic land card, reveal it, put it into your hand, then shuffle."
// cycle_card(p_landcycle => true) pays the cost, discards, and parks a
// STACK-LESS search_library decision whose options are only the basic lands in
// the owner's library; the existing submit branch places the pick and shuffles.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// LC1 — the full happy path: pay, discard, pick a basic, it lands in hand.
test('LC1 landcycling discards, offers only basics, and puts the pick in hand', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Landcycling Test', 'hand')
    const forest = await s.spawn('A', 'Forest Test', 'library')
    const island = await s.spawn('A', 'Island Test', 'library')
    await s.spawn('A', 'Goblin Raider Test', 'library') // non-basic: must NOT be offered
    await s.setMana('A', { C: 2 })

    const decisionId = await s.as('A').cycle(spell, null, true)
    assert.ok(decisionId, 'landcycle returns the parked decision id')
    assert.equal(await s.zoneOf(spell), 'graveyard') // discarded, no draw happened

    const decision = await s.pendingDecision()
    assert.ok(decision)
    assert.equal(decision.id, decisionId)
    assert.equal(decision.decision_type, 'search_library')
    assert.equal(decision.source_stack_item_id, null) // stack-less
    const offered = (decision.options as Array<{ game_card_id: string }>).map((o) => o.game_card_id).sort()
    assert.deepEqual(offered, [forest, island].sort()) // basics only

    await s.as('A').submitDecision(decision.id, { chosen: [forest] })
    assert.equal(await s.zoneOf(forest), 'hand')
    assert.equal(await s.zoneOf(island), 'library')
    assert.equal(await s.pendingCount(), 0) // resolved without a stack resume
  })
})

// LC2 — a plain-cycling card has no landcycling ability.
test('LC2 landcycle on a plain-cycling card is rejected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const land = await s.spawn('A', 'Cycling Land Test', 'hand')
    await s.setMana('A', { C: 2 })
    await assert.rejects(() => s.as('A').cycle(land, null, true), /no landcycling ability/i)
  })
})

// LC3 — min_choices is 0: declining the search still resolves the decision.
test('LC3 landcycling with no pick still resolves (fail to find)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Landcycling Test', 'hand')
    const forest = await s.spawn('A', 'Forest Test', 'library')
    await s.setMana('A', { C: 2 })

    const decisionId = await s.as('A').cycle(spell, null, true)
    assert.ok(decisionId)
    await s.as('A').submitDecision(decisionId, { chosen: [] })
    assert.equal(await s.zoneOf(forest), 'library') // nothing moved
    assert.equal(await s.pendingCount(), 0)
  })
})

// LC4 — the mana cost is real: an empty pool rejects and rolls back.
test('LC4 landcycling needs the cost paid', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Landcycling Test', 'hand')
    await assert.rejects(() => s.as('A').cycle(spell, null, true))
  })
})
