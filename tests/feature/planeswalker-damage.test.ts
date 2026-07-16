// mig 412 — single-target deal_damage can hit a planeswalker (loyalty loss), and
// a sacrifice_creature COST reads p_cost_card_ids so a targeted effect (Goblin
// Bombardment: "Sacrifice a creature: deal 1 damage to any target") keeps its own
// target. Two engine touches in one card.

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
    "select (counters ->> 'loyalty') as l from public.game_cards where id = $1", [card])
  return r.rows[0]?.l == null ? 0 : Number(r.rows[0]!.l)
}

// PWD1 — Goblin Bombardment sacrifices a creature (paid via cost card) and deals
// 1 damage to an opponent's planeswalker, removing 1 loyalty (4 → 3).
test('PWD1 sac-to-damage hits an opponent planeswalker for loyalty', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const pw = await s.spawn('B', 'Test Walker', 'battlefield') // loyalty 4
    const bomb = await s.spawn('A', 'Goblin Bombardment Test', 'battlefield')
    const fodder = await s.spawnCreature('A', 'Grave Shambler Test')

    await s.as('A').activate(bomb, 0, { costCardIds: [fodder], targetCardId: pw })
    await s.as('A').resolveStack() // resolve the deal_damage_creature action

    assert.equal(await loyalty(s, pw), 3) // 4 − 1 loyalty
    assert.equal(await s.zoneOf(pw), 'battlefield')
    assert.equal(await s.zoneOf(fodder), 'graveyard') // the creature was the cost
  })
})

// PWD2 — the same ability still damages a creature target (the shared applier
// keeps the creature path intact; two-picks doesn't break single-permanent damage).
test('PWD2 sac-to-damage still marks a creature target', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bomb = await s.spawn('A', 'Goblin Bombardment Test', 'battlefield')
    const fodder = await s.spawnCreature('A', 'Grave Shambler Test')
    const victim = await s.spawnCreature('B', 'Grave Shambler Test') // 2/2

    await s.as('A').activate(bomb, 0, { costCardIds: [fodder], targetCardId: victim })
    await s.as('A').resolveStack() // resolve the deal_damage_creature action

    const dmg = await s.client.query<{ damage_marked: number }>(
      'select damage_marked from public.game_cards where id = $1', [victim])
    assert.equal(dmg.rows[0]!.damage_marked, 1)
    assert.equal(await s.zoneOf(fodder), 'graveyard')
  })
})
