// mig 397 — grant_keyword 'unblockable' ("can't be blocked this turn"):
// apply_creature_effect writes an until-EOT 'unblockable' continuous effect and
// declare_blocker rejects every block against the attacker (Rogue's Passage,
// Hraesvelgr of the First Brood's rider).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// UB1 — an attacker with the grant cannot be blocked; a plain attacker can.
test('UB1 unblockable grant forbids blocks until end of turn', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const runner = await s.spawnCreature('A', 'Goblin Raider Test') // 2/2
    const wall = await s.spawnCreature('B', 'Air Elemental Test') // 4/4

    // Grant via the same applier grant_keyword uses at resolve time.
    await s.client.query(
      `select public.apply_creature_effect($1, 'grant_keyword', $2, $3::jsonb)`,
      [s.sessionId, runner, JSON.stringify({ keyword: 'unblockable' })])

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(runner, 'B')
    await s.setTurn({ phase: 'combat', step: 'declare_blockers', active: 'A', priority: 'B' })

    await assert.rejects(
      s.as('B').declareBlocker(wall, runner),
      /can't be blocked this turn/,
    )
  })
})
