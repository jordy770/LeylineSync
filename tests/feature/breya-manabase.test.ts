// mig 263 — Breya mana base. Engine touch: bounce_up_to type_line filter
// (karoo lands: "return a LAND you control"). The rest is script-only.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// BM1 — Azorius Chancery: enters tapped, bounces only LANDS you control,
// and one tap yields both {W} and {U}.
test('BM1 karoo land bounce and double mana', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const forest = await s.spawn('A', 'Forest Test', 'battlefield')
    await s.spawnCreature('A', 'Dino Grunt Test') // a NON-land — must not be offered

    const karoo = await s.spawn('A', 'Azorius Chancery Test', 'battlefield')
    await s.as('A').resolveStack() // the ETB bounce trigger
    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'bounce_pick')
    const offered = (d!.options as Array<{ name: string }>).map((o) => o.name)
    assert.ok(offered.every((n) => n !== 'Dino Grunt Test')) // lands only
    await s.as('A').submitDecision(d!.id, { chosen: [forest] })

    const bounced = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [forest])
    assert.equal(bounced.rows[0]!.zone, 'hand')

    await s.client.query(
      'update public.game_cards set is_tapped = false where id = $1', [karoo])
    const pool = await s.as('A').activateMana(karoo)
    assert.equal(pool.W, 1) // one tap, two mana
    assert.equal(pool.U, 1)
  })
})

// BM2 (mig 411) — the karoo bounce is MANDATORY: with a land available the
// decision forces exactly one pick (min_choices = 1) and declining is rejected.
test('BM2 mandatory karoo bounce cannot be declined', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const forest = await s.spawn('A', 'Forest Test', 'battlefield')

    await s.spawn('A', 'Azorius Chancery Test', 'battlefield')
    await s.as('A').resolveStack() // the ETB bounce trigger
    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'bounce_pick')

    const row = await s.client.query<{ min_choices: number; max_choices: number }>(
      'select min_choices, max_choices from public.game_pending_decisions where id = $1', [d!.id])
    assert.equal(row.rows[0]!.min_choices, 1) // forced — not "up to"
    assert.equal(row.rows[0]!.max_choices, 1)
    void forest

    // Declining (empty pick) must be rejected by min_choices enforcement. This
    // raises inside the DB, aborting the tx, so it is the last DB action here —
    // BM1 already proves the mandatory fixture resolves a real pick to hand.
    await assert.rejects(
      s.as('A').submitDecision(d!.id, { chosen: [] }),
      /choose|choices|at least|min/i)
  })
})
