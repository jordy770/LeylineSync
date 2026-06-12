// Millicent batch 1 (script-only): the commander's two token paths — a
// nontoken Spirit dying and a nontoken Spirit connecting both make Spirits.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

const countSpirits = async (s: Scenario) => {
  const r = await s.client.query<{ n: string }>(
    `select count(*)::int as n from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.zone = 'battlefield' and c.name = 'Spirit Token'`,
    [s.sessionId])
  return Number(r.rows[0]!.n)
}

// MS1 — Millicent herself connecting makes a Spirit; that TOKEN Spirit
// connecting later makes nothing (nontoken filter).
test('MS1 Millicent token paths respect the nontoken filter', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const milli = await s.spawnCreature('A', 'Millicent Revenant Test')
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(milli, 'B')
    await s.setTurn({ phase: 'combat', step: 'combat_damage', active: 'A', priority: 'A' })
    await s.resolveCombat()
    await s.as('A').resolveStack() // the connect trigger
    assert.equal(await countSpirits(s), 1)

    // The nontoken Spirit dying also pays out.
    await s.putInGraveyard(milli)
    await s.as('A').resolveStack()
    assert.equal(await countSpirits(s), 2)
  })
})
