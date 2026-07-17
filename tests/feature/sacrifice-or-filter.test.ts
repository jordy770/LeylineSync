// mig 417 — the sacrifice effect filter accepts type_line_any ("sacrifice an
// artifact or creature": Deadly Dispute, Costly Plunder), so a Treasure/artifact
// can pay the additional cost, not only a creature.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function handCount(s: Scenario, seat: 'A'): Promise<number> {
  const r = await s.client.query<{ n: string }>(
    `select count(*)::int as n from public.game_cards
     where session_id = $1 and owner_id = $2 and zone = 'hand'`,
    [s.sessionId, s.players[seat]])
  return Number(r.rows[0]!.n)
}

// SOF1 — "sacrifice an artifact or creature, draw two" paid with an ARTIFACT while
// controlling NO creatures (the old creature-only filter would offer nothing).
test('SOF1 an artifact can pay a "sacrifice an artifact or creature" cost', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const art = await s.spawn('A', 'Unstable Obelisk Test', 'battlefield') // an artifact, no creatures
    for (let i = 0; i < 3; i++) await s.spawn('A', 'Forest Test', 'library')
    const hand0 = await handCount(s, 'A')

    await s.as('A').castSpellEffect([
      { type: 'sacrifice', who: 'you', count: 1, filter: { type_line_any: ['artifact', 'creature'] } },
      { type: 'draw', amount: 2 }])
    await s.as('A').resolveStack()

    const d = await s.pendingDecision()
    assert.equal(d?.decision_type, 'sacrifice')
    const offered = (d!.options as Array<{ game_card_id: string }>).map((o) => o.game_card_id)
    assert.ok(offered.includes(art), 'the artifact is a legal sacrifice')
    await s.as('A').submitDecision(d!.id, { chosen: [art] })

    assert.equal(await s.zoneOf(art), 'graveyard') // artifact sacrificed
    assert.equal(await handCount(s, 'A'), hand0 + 2) // then drew two
  })
})
