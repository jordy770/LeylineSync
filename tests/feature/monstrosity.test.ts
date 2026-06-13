// Monstrosity (mig 232) — Stormbreath Dragon: "{5}{R}{R}: Monstrosity 3. When
// this creature becomes monstrous, it deals damage to each opponent equal to the
// number of cards in that player's hand." Becoming monstrous is a once-only marker.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function counters(s: Scenario, cardId: string): Promise<{ plus: number; monstrous: number }> {
  const r = await s.client.query<{ plus_one_counters: number; counters: Record<string, number> }>(
    `select plus_one_counters, counters from public.game_cards where id = $1`, [cardId])
  return { plus: r.rows[0]!.plus_one_counters, monstrous: Number(r.rows[0]!.counters?.monstrous ?? 0) }
}

// MO1 — monstrosity adds 3 counters, sets the marker, and burns each opponent
// for their hand size.
test('MO1 monstrosity grows the Dragon and burns opponents by hand size', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const storm = await s.spawnCreature('A', 'Stormbreath Dragon Test')
    await s.spawn('B', 'Air Elemental Test', 'hand')
    await s.spawn('B', 'Air Elemental Test', 'hand') // B holds two cards
    const lifeBefore = await s.lifeOf('B')

    await s.setMana('A', { C: 5, R: 2 }) // {5}{R}{R}
    await s.as('A').activate(storm, 0)
    await s.as('A').resolveStack() // monstrosity resolves

    const c = await counters(s, storm)
    assert.equal(c.plus, 3)
    assert.equal(c.monstrous, 1)
    assert.equal(await s.lifeOf('B'), lifeBefore - 2) // two cards in hand
  })
})

// MO2 — a second activation is a no-op: already monstrous, no more counters or burn.
test('MO2 monstrosity does nothing the second time', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const storm = await s.spawnCreature('A', 'Stormbreath Dragon Test')
    await s.spawn('B', 'Air Elemental Test', 'hand')

    await s.setMana('A', { C: 10, R: 4 })
    await s.as('A').activate(storm, 0)
    await s.as('A').resolveStack()
    const lifeAfter1 = await s.lifeOf('B')

    await s.as('A').activate(storm, 0)
    await s.as('A').resolveStack()

    const c = await counters(s, storm)
    assert.equal(c.plus, 3) // still only 3
    assert.equal(await s.lifeOf('B'), lifeAfter1) // no further burn
  })
})
