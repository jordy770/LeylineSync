// Planeswalker combat (roadmap Tribal #4, slice 2). A creature can attack a planeswalker;
// unblocked combat damage removes that much loyalty (0 → graveyard). A blocker still
// soaks the damage as normal, sparing the planeswalker.

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
    "select (counters ->> 'loyalty') as l from public.game_cards where id = $1",
    [card],
  )
  return r.rows[0]?.l == null ? 0 : Number(r.rows[0]!.l)
}

// PWC1 — an unblocked attacker removes loyalty equal to its power.
test('PWC1 unblocked attacker removes loyalty', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const pw = await s.spawn('B', 'Test Walker', 'battlefield') // loyalty 4
    const attacker = await s.spawnCreature('A', 'Grave Shambler Test') // 2/2

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttackerVsPlaneswalker(attacker, pw)
    await s.setTurn({ phase: 'combat', step: 'combat_damage', active: 'A', priority: 'A' })
    await s.as('A').resolveCombat()

    assert.equal(await loyalty(s, pw), 2) // 4 − 2
    assert.equal(await s.zoneOf(pw), 'battlefield')
  })
})

// PWC2 — lethal loyalty damage sends the planeswalker to the graveyard.
test('PWC2 lethal loyalty damage kills the planeswalker', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const pw = await s.spawn('B', 'Test Walker', 'battlefield') // loyalty 4
    const attacker = await s.spawnCreature('A', 'Air Elemental Test') // 4/4

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttackerVsPlaneswalker(attacker, pw)
    await s.setTurn({ phase: 'combat', step: 'combat_damage', active: 'A', priority: 'A' })
    await s.as('A').resolveCombat()

    assert.equal(await s.zoneOf(pw), 'graveyard') // 4 damage to 4 loyalty
  })
})

// PWC3 — a blocker soaks the damage; the planeswalker is unharmed.
test('PWC3 a blocker spares the planeswalker', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const pw = await s.spawn('B', 'Test Walker', 'battlefield') // loyalty 4
    const attacker = await s.spawnCreature('A', 'Air Elemental Test') // 4/4
    const blocker = await s.spawnCreature('B', 'Air Elemental Test') // 4/4

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttackerVsPlaneswalker(attacker, pw)
    await s.setTurn({ phase: 'combat', step: 'declare_blockers', active: 'A', priority: 'B' })
    await s.as('B').declareBlocker(blocker, attacker)
    await s.setTurn({ phase: 'combat', step: 'combat_damage', active: 'A', priority: 'A' })
    await s.as('A').resolveCombat()

    assert.equal(await loyalty(s, pw), 4) // unharmed — the blocker took it
    assert.equal(await s.zoneOf(pw), 'battlefield')
  })
})
