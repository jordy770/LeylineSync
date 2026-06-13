// mig 238 — Nesting Dragon (landfall) + Sarkhan cost reduction.
//   • land_entered watcher: playing a land makes Nesting Dragon spawn a Dragon
//     Egg token, whose own dies trigger makes a 2/2 flying Dragon Hatchling.
//   • Sarkhan, Soul Aflame: its cost_reduction half (Dragon spells cost {1} less).
//     The become-a-copy ability is not modelled.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function countToken(s: Scenario, seat: 'A' | 'B', name: string): Promise<number> {
  const r = await s.client.query<{ n: string }>(
    `select count(*)::int as n from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.controller_player_id = $2 and gc.zone = 'battlefield' and c.name = $3`,
    [s.sessionId, s.players[seat], name])
  return Number(r.rows[0]!.n)
}

// NL1 — Nesting Dragon: a land entering makes an Egg; the Egg dying makes a Hatchling.
test('NL1 Nesting Dragon spawns an Egg on landfall, a Hatchling when it dies', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Nesting Dragon Test')
    const land = await s.spawn('A', 'Wastes Test', 'hand')

    await s.as('A').castPermanent(land) // landfall
    await s.as('A').resolveStack() // land_entered trigger → Dragon Egg
    assert.equal(await countToken(s, 'A', 'Dragon Egg Token'), 1)

    // Kill the Egg → its dies trigger makes a Hatchling.
    const egg = (await s.client.query<{ id: string }>(
      `select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
       where gc.session_id = $1 and c.name = 'Dragon Egg Token' and gc.zone = 'battlefield'`,
      [s.sessionId])).rows[0]!.id
    await s.putInGraveyard(egg)
    await s.as('A').resolveStack() // dies trigger → Dragon Hatchling
    assert.equal(await countToken(s, 'A', 'Dragon Hatchling Token'), 1)
  })
})

// NL2 — Sarkhan reduces a Dragon's generic cost by one.
test('NL2 Sarkhan makes a Dragon cost {1} less', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Sarkhan, Soul Aflame Test')
    await s.as('A').rebuild()
    const dragon = await s.spawn('A', 'Rapacious Dragon Test', 'hand') // {4}{R}

    await s.setMana('A', { C: 3, R: 1 }) // exactly {3}{R} — only enough if reduced
    await s.as('A').castPermanent(dragon) // succeeds only if reduced
    assert.notEqual((await s.cardState(dragon)).zone, 'hand') // it was cast
  })
})
