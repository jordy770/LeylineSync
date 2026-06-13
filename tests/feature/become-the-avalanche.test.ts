// mig 243 — Become the Avalanche: "Draw a card for each creature you control
// with power 4 or greater. Then creatures you control get +X/+X until end of
// turn, where X is the number of cards in your hand."
//   • count creatures_you_control gains min_power (effective power).
//   • new count cards_in_hand.
//   • pump_all wired into the program resolver; the until-EOT mass-pump
//     helper resolves count-based power/toughness at apply time.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

const AVALANCHE_ACTIONS = [
  { type: 'draw', amount: { count: 'creatures_you_control', min_power: 4 } },
  { type: 'pump_all', scope: 'controller', power: { count: 'cards_in_hand' }, toughness: { count: 'cards_in_hand' } },
]

// BA1 — two 5/5s and a 3/3: draw 2 (only the 5/5s count), then all three get
// +2/+2 (hand size after drawing).
test('BA1 Become the Avalanche draws per power-4+ creature then mass-pumps by hand size', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const big1 = await s.spawnCreature('A', 'Dragon Token') // 5/5
    const big2 = await s.spawnCreature('A', 'Dragon Token') // 5/5
    const small = await s.spawnCreature('A', 'Rapacious Dragon Test') // 3/3
    await s.as('A').resolveStack() // Rapacious ETB Treasures
    for (let i = 0; i < 4; i++) await s.spawn('A', 'Wastes Test', 'library')

    await s.as('A').castSpellEffect(AVALANCHE_ACTIONS)
    await s.as('A').resolveStack()

    const hand = await s.client.query<{ n: string }>(
      `select count(*)::int as n from public.game_cards
       where session_id = $1 and owner_id = $2 and zone = 'hand'`,
      [s.sessionId, s.players.A])
    assert.equal(Number(hand.rows[0]!.n), 2) // only the two 5/5s drew
    assert.equal(await s.effectivePower(big1), 7) // 5 + 2
    assert.equal(await s.effectivePower(big2), 7)
    assert.equal(await s.effectivePower(small), 5) // 3 + 2
    assert.equal(await s.effectiveToughness(small), 5)
  })
})
