// mig 254 — enrage: "whenever this creature is dealt damage", broadcast from
// apply_damage_to_creature BEFORE the lethal sweep (a dying creature still
// enrages). Unlocks the Veloci-Ramp-Tor enrage family; Marauding Raptor is
// script-only and chains into it (its 2 damage to an entering Dinosaur).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function handCount(s: Scenario, seat: 'A' | 'B'): Promise<number> {
  const r = await s.client.query<{ n: string }>(
    `select count(*)::int as n from public.game_cards
     where session_id = $1 and owner_id = $2 and zone = 'hand'`,
    [s.sessionId, s.players[seat]])
  return Number(r.rows[0]!.n)
}

// EN1 — direct damage on Ripjaw Raptor draws a card.
test('EN1 Ripjaw Raptor enrages into a draw', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const ripjaw = await s.spawnCreature('A', 'Ripjaw Raptor Test') // 4/5
    await s.spawn('A', 'Wastes Test', 'library')

    await s.as('A').castSpellEffect(
      [{ type: 'deal_damage', amount: 2, target_type: 'creature' }], null, null, ripjaw)
    await s.as('A').resolveStack() // damage lands, enrage enqueued
    await s.as('A').resolveStack() // the enrage trigger

    assert.equal(await handCount(s, 'A'), 1)
    const dmg = await s.client.query<{ damage_marked: number }>(
      'select damage_marked from public.game_cards where id = $1', [ripjaw])
    assert.equal(dmg.rows[0]!.damage_marked, 2)
  })
})

// EN2 — Marauding Raptor pings an entering Ripjaw, which enrages: the whole
// chain is watcher -> reflexive damage -> enrage -> draw.
test('EN2 Marauding Raptor chains into the entering Dinosaur enrage', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Marauding Raptor Test')
    await s.spawn('A', 'Wastes Test', 'library')

    const ripjaw = await s.spawnCreature('A', 'Ripjaw Raptor Test') // fires the watcher
    await s.as('A').resolveStack() // Marauding's 2 damage to it; enrage enqueued
    await s.as('A').resolveStack() // the enrage trigger -> draw

    assert.equal(await handCount(s, 'A'), 1)
    const dmg = await s.client.query<{ damage_marked: number }>(
      'select damage_marked from public.game_cards where id = $1', [ripjaw])
    assert.equal(dmg.rows[0]!.damage_marked, 2)
  })
})

// EN3 — Ranging Raptors enrages into a basic-land search onto the battlefield.
test('EN3 Ranging Raptors enrages into a land search', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const raptors = await s.spawnCreature('A', 'Ranging Raptors Test')
    const land = await s.spawn('A', 'Island Test', 'library') // Basic Land - Island

    await s.as('A').castSpellEffect(
      [{ type: 'deal_damage', amount: 1, target_type: 'creature' }], null, null, raptors)
    await s.as('A').resolveStack()
    await s.as('A').resolveStack() // enrage -> search parks

    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'search_library')
    await s.as('A').submitDecision(d!.id, { chosen: [land] })
    const row = await s.client.query<{ zone: string; is_tapped: boolean }>(
      'select zone, is_tapped from public.game_cards where id = $1', [land])
    assert.equal(row.rows[0]!.zone, 'battlefield')
    assert.equal(row.rows[0]!.is_tapped, true)
  })
})
