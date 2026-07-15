// Shivan Devastator (Prosper precon) — "enters with X +1/+1 counters":
// enters_with_counters amount {counters:'x', of:'self'} reads the counters.x
// stamp cast_card_from_hand writes for an {X} permanent (mig 300). Schema-only
// unlock — no migration; this proves the existing runtime path end-to-end.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

test('SD1 an X=3 Shivan enters as a 3/3 (0/0 plus three +1/+1 counters)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const shivan = await s.spawn('A', 'Shivan Devastator Test', 'hand') // {X}{R} 0/0

    await s.setMana('A', { C: 3, R: 1 }) // X=3 → {3}{R}
    await s.as('A').castPermanent(shivan, { x: 3 })
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(shivan), 'battlefield')
    assert.equal(await s.effectivePower(shivan), 3)
    assert.equal(await s.effectiveToughness(shivan), 3)
  })
})

// SD2 — X=1 enters as exactly a 1/1: proves the counter amount is the stamped
// X, not a floor/fallback. (An X=0 cast leaves a 0/0 that the 704.5f sweep only
// collects at the next damage event — a general engine timing behavior, not
// specific to this card.)
test('SD2 an X=1 Shivan enters as exactly a 1/1', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const shivan = await s.spawn('A', 'Shivan Devastator Test', 'hand')

    await s.setMana('A', { C: 1, R: 1 }) // X=1 → {1}{R}
    await s.as('A').castPermanent(shivan, { x: 1 })
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(shivan), 'battlefield')
    assert.equal(await s.effectivePower(shivan), 1)
    assert.equal(await s.effectiveToughness(shivan), 1)
  })
})
