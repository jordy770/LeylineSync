// Liliana, Untouched by Death — her +1 (conditional mill). "Mill three cards. If at
// least one Zombie card is milled this way, each opponent loses 2 life and you gain 2."
// Exercises the planeswalker loyalty framework + the conditional-mill feature.
// (Her -2 needs loyalty targeting + dynamic pump, -3 needs cast-from-graveyard — both
// authored as labelled stubs, not tested here.)

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function loyalty(s: Scenario, card: string): Promise<number> {
  const r = await s.client.query<{ l: string | null }>(
    "select (counters ->> 'loyalty') as l from public.game_cards where id = $1", [card],
  )
  return r.rows[0]?.l == null ? 0 : Number(r.rows[0]!.l)
}

// LIL1 — milling a Zombie triggers the drain (B loses 2, A gains 2); loyalty 4→5.
test('LIL1 +1 drains when a Zombie is milled', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const lil = await s.spawn('A', 'Liliana, Untouched by Death', 'battlefield')
    await s.spawn('A', 'Grave Shambler Test', 'library') // a Zombie in the top 3
    await s.spawn('A', 'Air Elemental Test', 'library')
    await s.spawn('A', 'Air Elemental Test', 'library')
    const aBefore = await s.lifeOf('A')
    const bBefore = await s.lifeOf('B')

    await s.as('A').activateLoyalty(lil, 0)
    await s.as('A').resolveStack()

    assert.equal(await loyalty(s, lil), 5)
    assert.equal(await s.lifeOf('B'), bBefore - 2)
    assert.equal(await s.lifeOf('A'), aBefore + 2)
  })
})

// LIL2 — milling no Zombies does NOT drain.
test('LIL2 +1 does not drain without a Zombie milled', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const lil = await s.spawn('A', 'Liliana, Untouched by Death', 'battlefield')
    await s.spawn('A', 'Air Elemental Test', 'library')
    await s.spawn('A', 'Air Elemental Test', 'library')
    await s.spawn('A', 'Air Elemental Test', 'library')
    const bBefore = await s.lifeOf('B')

    await s.as('A').activateLoyalty(lil, 0)
    await s.as('A').resolveStack()

    assert.equal(await loyalty(s, lil), 5)
    assert.equal(await s.lifeOf('B'), bBefore) // no Zombie milled → no drain
    assert.equal(await s.zoneCount('A', 'graveyard'), 3) // still milled 3
  })
})
