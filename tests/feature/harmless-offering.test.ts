// Harmless Offering (mig 353). "Target opponent gains control of target permanent
// you control." gain_control gains a to:'opponent' direction — the targeted
// permanent goes to an opponent of the caster (1v1: the only one) instead of the
// caster gaining it.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// HO1 — donate a permanent you control to your opponent.
test('HO1 the targeted permanent goes to the opponent', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bear = await s.spawnCreature('A', 'Vampire Bear Test') // A controls it
    assert.equal((await s.cardState(bear)).controller_player_id, s.playerId('A'))

    await s.as('A').castSpellEffect(
      [{ type: 'gain_control', target_type: 'permanent', target_controller: 'you', to: 'opponent' }],
      null, null, bear)
    await s.as('A').resolveStack()

    assert.equal((await s.cardState(bear)).controller_player_id, s.playerId('B'), 'B now controls it')
  })
})
