// Temur Dragons ramp package (free compositions, no new engine):
//   • Fellwar Stone / Exotic Orchard — "any color a land an opponent controls
//     could produce" is modelled as a tap-for-any-colour source (the chosen
//     colour is picked at activation, like a Treasure without the sacrifice).
//   • Kodama's Reach — search up to two basics: one onto the battlefield tapped,
//     the other into hand (two sequential search_library effects).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function zoneOf(s: Scenario, cardId: string): Promise<{ zone: string; tapped: boolean }> {
  const r = await s.client.query<{ zone: string; is_tapped: boolean }>(
    `select zone, is_tapped from public.game_cards where id = $1`, [cardId])
  return { zone: r.rows[0]!.zone, tapped: r.rows[0]!.is_tapped }
}

// RM1 — Fellwar Stone taps for a chosen colour.
test('RM1 Fellwar Stone taps for any chosen colour', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const stone = await s.spawn('A', 'Fellwar Stone Test', 'battlefield')
    const pool = await s.as('A').activateMana(stone, 0, null, 'G')
    assert.equal(pool.G, 1)
  })
})

// RM2 — Exotic Orchard taps for a chosen colour.
test('RM2 Exotic Orchard taps for any chosen colour', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const land = await s.spawn('A', 'Exotic Orchard Test', 'battlefield')
    const pool = await s.as('A').activateMana(land, 0, null, 'U')
    assert.equal(pool.U, 1)
  })
})

// RM3 — Kodama's Reach: one basic to the battlefield tapped, the other to hand.
test('RM3 Kodama\'s Reach ramps one basic and draws the other', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const toField = await s.spawn('A', 'Wastes Test', 'library')
    const toHand = await s.spawn('A', 'Island Test', 'library')
    await s.spawn('A', 'Air Elemental Test', 'library') // a nonland, not a legal target

    await s.as('A').castSpellEffect([
      { type: 'search_library', count: 1, to: 'battlefield', tapped: true, filter: { type_line: 'Basic Land' } },
      { type: 'search_library', count: 1, to: 'hand', filter: { type_line: 'Basic Land' } },
    ])
    await s.as('A').resolveStack()

    let d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { chosen: [toField] })
    d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { chosen: [toHand] })

    const field = await zoneOf(s, toField)
    assert.equal(field.zone, 'battlefield')
    assert.equal(field.tapped, true)
    assert.equal((await zoneOf(s, toHand)).zone, 'hand')
  })
})
