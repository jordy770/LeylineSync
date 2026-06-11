// Gadrak, the Crown-Scourge (mig 229) —
//   • "At the beginning of your end step, create a Treasure token for each
//     NONTOKEN creature that died this turn." A game-wide, turn-stamped count
//     (resolve_count_amount 'nontoken_creatures_died_this_turn') feeds a dynamic
//     create_token — and zero deaths makes zero tokens (no floor-at-1).
//   • "Gadrak can't attack unless you control four or more artifacts." A
//     top-level cant_attack_unless {count,at_least} gate in declare_attacker.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function treasureCount(s: Scenario, seat: 'A' | 'B'): Promise<number> {
  const r = await s.client.query<{ n: string }>(
    `select count(*)::int as n from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.controller_player_id = $2 and gc.zone = 'battlefield' and c.name = 'Treasure Token'`,
    [s.sessionId, s.players[seat]])
  return Number(r.rows[0]!.n)
}

// GA1 — one Treasure per nontoken creature that died this turn (any controller),
// and token deaths do NOT count.
test('GA1 Gadrak makes a Treasure per nontoken creature that died this turn', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Gadrak Test')

    // Two nontoken creatures die (one each side), plus a token creature death.
    const mine = await s.spawnCreature('A', 'Air Elemental Test')
    const theirs = await s.spawnCreature('B', 'Air Elemental Test')
    const tok = await s.spawnCreature('A', 'Beast Token')
    await s.putInGraveyard(mine)
    await s.putInGraveyard(theirs)
    await s.putInGraveyard(tok)

    await s.setTurn({ phase: 'ending', step: 'end', active: 'A', priority: 'A' })
    await s.as('A').resolveStack() // end-step trigger → Treasures

    assert.equal(await treasureCount(s, 'A'), 2) // 2 nontoken deaths, token excluded
  })
})

// GA2 — no nontoken deaths this turn → no Treasures (dynamic count is not floored at 1).
test('GA2 no deaths this turn makes zero Treasures', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Gadrak Test')

    await s.setTurn({ phase: 'ending', step: 'end', active: 'A', priority: 'A' })
    await s.as('A').resolveStack()

    assert.equal(await treasureCount(s, 'A'), 0)
  })
})

// GA3 — Gadrak can't attack with fewer than four artifacts. (A raised gate
// aborts the tx, so this rejection is the test's final action.)
test('GA3 Gadrak cannot attack with fewer than four artifacts', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const gadrak = await s.spawnCreature('A', 'Gadrak Test')

    for (let i = 0; i < 3; i++) await s.spawn('A', 'Treasure Token', 'battlefield')
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await assert.rejects(() => s.as('A').declareAttacker(gadrak, 'B'), /cannot attack/i)
  })
})

// GA4 — a fourth artifact unlocks the attack.
test('GA4 Gadrak attacks with four or more artifacts', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const gadrak = await s.spawnCreature('A', 'Gadrak Test')

    for (let i = 0; i < 4; i++) await s.spawn('A', 'Treasure Token', 'battlefield')
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(gadrak, 'B') // no throw
  })
})
