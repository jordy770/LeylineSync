// Cost reduction (mig 231) — reduced_mana_cost shaves generic mana at cast:
//   • Dragonlord's Servant: a STATIC cost_reduction continuous effect ("Dragon
//     spells you cast cost {1} less"), applied in cast_card_from_hand.
//   • Draconic Lore: a SELF cost_reduction script prop conditional on controlling
//     a Dragon ("costs {2} less"), applied in cast_spell_effect.
// Each test funds the player with EXACTLY the reduced cost, so a successful cast
// proves the reduction (an unreduced cast would be short on mana).

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

async function zoneCount(s: Scenario, seat: 'A' | 'B', zone: string): Promise<number> {
  const r = await s.client.query<{ n: string }>(
    `select count(*)::int as n from public.game_cards where session_id = $1 and owner_id = $2 and zone = $3`,
    [s.sessionId, s.players[seat], zone])
  return Number(r.rows[0]!.n)
}

// CR1 — Dragonlord's Servant makes a {4}{R} Dragon cost {3}{R}.
test('CR1 Dragonlord\'s Servant reduces a Dragon\'s generic cost by one', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', "Dragonlord's Servant Test")
    await s.as('A').rebuild() // register the static reduction
    const dragon = await s.spawn('A', 'Rapacious Dragon Test', 'hand') // {4}{R} Dragon

    await s.setMana('A', { C: 3, R: 1 }) // exactly {3}{R}
    await s.as('A').castPermanent(dragon) // auto-pays generic; succeeds only if reduced

    assert.deepEqual(await pool(s, 'A'), { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 })
  })
})

// CR2 — Draconic Lore costs {2} less while you control a Dragon, then draws three.
test('CR2 Draconic Lore self-reduces while you control a Dragon', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Dragon Token') // a Dragon on the battlefield (no ETB)
    const lore = await s.spawn('A', 'Draconic Lore Test', 'hand') // {3}{R} -> {1}{R}
    for (let i = 0; i < 4; i++) await s.spawn('A', 'Air Elemental Test', 'library')

    const before = await zoneCount(s, 'A', 'hand')
    await s.setMana('A', { C: 1, R: 1 }) // exactly {1}{R}
    await s.as('A').castSpellEffect([{ type: 'draw', amount: 3 }], lore)
    await s.as('A').resolveStack()

    // The spell left hand (cast) and drew three: net hand change = -1 + 3 = +2.
    assert.equal(await zoneCount(s, 'A', 'hand'), before + 2)
    assert.deepEqual(await pool(s, 'A'), { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 })
  })
})
