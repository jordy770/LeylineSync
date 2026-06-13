// mig 235 — three cards:
//   • Eshki, Temur's Roar — spell-cast power tiers (counter always; draw at power
//     4+; burn each opponent for Eshki's power at 6+).
//   • Thunderbreak Regent — "becomes target" punisher (3 to the targeting player).
//   • Spit Flame — 4 damage to target creature (graveyard recursion is deferred —
//     watchers don't fire from the graveyard).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function lifeOf(s: Scenario, seat: 'A' | 'B'): Promise<number> {
  const r = await s.client.query<{ life_total: number }>(
    `select life_total from public.game_session_players where session_id = $1 and player_id = $2`,
    [s.sessionId, s.players[seat]])
  return r.rows[0]!.life_total
}

// PT1 — casting a big creature triggers all three Eshki tiers.
test('PT1 Eshki: counter + draw + burn on a power-6 creature cast', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const eshki = await s.spawnCreature('A', 'Eshki Test') // 2/2
    const big = await s.spawn('A', 'Atarka World Render Test', 'hand') // 6/4 Dragon
    await s.spawn('A', 'Air Elemental Test', 'library') // a card to draw
    const handBefore = (await s.client.query<{ n: string }>(
      `select count(*)::int n from public.game_cards where session_id=$1 and owner_id=$2 and zone='hand'`,
      [s.sessionId, s.players.A])).rows[0]!.n
    const bLife = await lifeOf(s, 'B')

    await s.setMana('A', { C: 4, R: 1, G: 1 })
    await s.as('A').castPermanent(big)
    // Three Eshki triggers sit above the creature spell; resolve each.
    await s.as('A').resolveStack()
    await s.as('A').resolveStack()
    await s.as('A').resolveStack()

    // +1/+1 counter on Eshki, drew a card (power>=4), B burned for Eshki's power.
    assert.equal((await s.cardState(eshki)).plus_one_counters, 1)
    // Hand: -1 (cast big) +1 (drew) = net same as before minus the cast card... compare library drop instead.
    const libLeft = (await s.client.query<{ n: string }>(
      `select count(*)::int n from public.game_cards where session_id=$1 and owner_id=$2 and zone='library'`,
      [s.sessionId, s.players.A])).rows[0]!.n
    assert.equal(Number(libLeft), 0) // the one library card was drawn
    assert.ok(await lifeOf(s, 'B') < bLife) // burned by Eshki's power
    void handBefore
  })
})

// PT2 — Eshki does nothing extra on a small creature (power < 4): just the counter.
test('PT2 Eshki: only a counter on a small creature cast', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const eshki = await s.spawnCreature('A', 'Eshki Test')
    const small = await s.spawn('A', 'Red Wall Test', 'hand') // 0/4
    const bLife = await lifeOf(s, 'B')

    await s.setMana('A', { R: 1 })
    await s.as('A').castPermanent(small)
    await s.as('A').resolveStack()

    assert.equal((await s.cardState(eshki)).plus_one_counters, 1)
    assert.equal(await lifeOf(s, 'B'), bLife) // no burn
  })
})

// PT3 — Thunderbreak Regent burns the opponent who targets your Dragon.
test('PT3 Thunderbreak Regent deals 3 to a player targeting your Dragon', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'B', priority: 'B' })
    const regent = await s.spawnCreature('A', 'Thunderbreak Regent Test') // A's Dragon
    const bLife = await lifeOf(s, 'B')

    // B targets A's Dragon with a removal action.
    await s.as('B').putOnStack('destroy_creature', { target_card_id: regent })
    await s.as('B').resolveStack() // Thunderbreak's trigger resolves first

    assert.equal(await lifeOf(s, 'B'), bLife - 3)
  })
})

// PT4 — Spit Flame deals 4 to a target creature.
test('PT4 Spit Flame deals 4 to a target creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const victim = await s.spawnCreature('B', 'Air Elemental Test') // 4/4
    const spit = await s.spawn('A', 'Spit Flame Test', 'hand')

    await s.setMana('A', { C: 1, R: 1 })
    await s.as('A').castSpellEffect([{ type: 'deal_damage', amount: 4, target_type: 'creature' }], spit, null, victim)
    await s.as('A').resolveStack()

    assert.equal((await s.cardState(victim)).zone, 'graveyard') // 4 >= 4 toughness
  })
})
