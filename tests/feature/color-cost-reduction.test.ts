// mig 391 — color-filtered static cost_reduction (Sapphire Medallion, Talrand
// precon): "Blue spells you cast cost {1} less." Funding exactly the reduced
// cost proves the reduction; a non-blue spell must NOT be discounted.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function pool(s: Scenario, seat: 'A' | 'B'): Promise<Record<string, number>> {
  const r = await s.client.query<{ mana_pool: Record<string, number> }>(
    `select mana_pool from public.game_players where session_id = $1 and player_id = $2`,
    [s.sessionId, s.players[seat]])
  return r.rows[0]?.mana_pool ?? {}
}

// SM1 — a {2}{U} blue sorcery casts for {1}{U} with the Medallion out.
test('SM1 Sapphire Medallion discounts a blue spell by one generic', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Sapphire Medallion Test', 'battlefield')
    await s.as('A').rebuild() // register the static reduction
    const ideas = await s.spawn('A', 'Blue Ideas Test', 'hand') // {2}{U}
    for (let i = 0; i < 3; i++) await s.spawn('A', 'Air Elemental Test', 'library')

    await s.setMana('A', { C: 1, U: 1 }) // exactly the reduced {1}{U}
    await s.as('A').castSpellEffect([{ type: 'draw', amount: 2 }], ideas)
    await s.as('A').resolveStack()

    assert.deepEqual(await pool(s, 'A'), { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 })
  })
})

// SM2 — a RED spell gets no discount: funding one generic short must fail.
test('SM2 Sapphire Medallion does not discount a red spell', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Sapphire Medallion Test', 'battlefield')
    await s.as('A').rebuild()
    const lore = await s.spawn('A', 'Draconic Lore Test', 'hand') // {3}{R}, no Dragon around

    await s.setMana('A', { C: 2, R: 1 }) // one short of the real {3}{R}
    await assert.rejects(
      () => s.as('A').castSpellEffect([{ type: 'draw', amount: 3 }], lore),
      /mana/i,
    )
  })
})
