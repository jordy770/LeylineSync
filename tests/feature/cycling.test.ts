// Cycling (mig 228) — "Cycling {2}: Discard this card, draw a card." The
// cycle_card RPC pays the cost, discards from hand, draws one.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// CY1 — cycle a card: it goes to the graveyard and you draw.
test('CY1 cycling discards the card and draws one', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const land = await s.spawn('A', 'Cycling Land Test', 'hand')
    const top = await s.spawn('A', 'Air Elemental Test', 'library')
    await s.setMana('A', { C: 2 }) // {2}

    const drawn = await s.as('A').cycle(land)
    assert.equal(drawn, top) // drew the top of library
    assert.equal(await s.zoneOf(land), 'graveyard') // discarded
    assert.equal(await s.zoneOf(top), 'hand')
  })
})

// CY2 — a card with no cycling cost can't be cycled.
test('CY2 a non-cycling card is rejected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const goblin = await s.spawn('A', 'Goblin Raider Test', 'hand')

    await assert.rejects(() => s.as('A').cycle(goblin), /no cycling ability/i)
  })
})

// CY3 — cycling needs the mana; an empty pool is rejected and the card stays.
test('CY3 cycling needs the mana cost paid', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const land = await s.spawn('A', 'Cycling Land Test', 'hand')
    // no mana set → the mana payment fails and the cycle is rolled back.
    await assert.rejects(() => s.as('A').cycle(land))
  })
})
