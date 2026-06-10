// Treasure tokens (mig 226) — "{T}, Sacrifice this artifact: Add one mana of
// any color." activate_mana_ability now accepts a sacrifice_self cost and a
// caller-picked colour for an "any" producer.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function treasures(s: Scenario, seat: 'A' | 'B'): Promise<string[]> {
  const r = await s.client.query<{ id: string }>(
    `select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.controller_player_id = $2 and gc.zone = 'battlefield' and c.name = 'Treasure Token'`,
    [s.sessionId, s.players[seat]])
  return r.rows.map((x) => x.id)
}

// TR1 — Rapacious Dragon makes two Treasures; cracking one adds the chosen
// colour and sends the token to the graveyard (a token then ceases to exist).
test('TR1 a Treasure cracks for the chosen colour and is sacrificed', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Rapacious Dragon Test')
    await s.as('A').resolveStack() // ETB → two Treasures

    const made = await treasures(s, 'A')
    assert.equal(made.length, 2)

    const pool = await s.as('A').activateMana(made[0]!, 0, null, 'R')
    assert.equal(pool.R, 1) // produced red

    // The sacrificed token is gone from the battlefield (token cease-to-exist).
    assert.equal((await treasures(s, 'A')).length, 1)
  })
})

// TR2 — producing without choosing a colour is rejected.
test('TR2 an any-colour producer needs a chosen colour', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Rapacious Dragon Test')
    await s.as('A').resolveStack()
    const made = await treasures(s, 'A')

    await assert.rejects(() => s.as('A').activateMana(made[0]!, 0, null, null), /choose a colour/i)
  })
})
