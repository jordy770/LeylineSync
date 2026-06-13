// mig 277 — land animation: Obuun animates a land into an X/X (X = his
// power) attacker with trample and haste; the animation expires at EOT.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// LA1 — Obuun's combat trigger animates a Forest into a 3/3 that can attack.
test('LA1 Obuun animates a land that can attack', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Obuun Ancestor Test') // 3/4
    const forest = await s.spawn('A', 'Forest Test', 'battlefield')

    await s.setTurn({ phase: 'combat', step: 'beginning_of_combat', active: 'A', priority: 'A' })
    const item = await s.topStackItem()
    assert.equal(item?.action_type, 'triggered_ability')
    await s.as('A').chooseTriggerTarget(item!.id, forest)
    await s.as('A').resolveStack()

    assert.equal(await s.effectivePower(forest), 3) // X = Obuun's power
    assert.equal(await s.effectiveToughness(forest), 3)

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(forest, 'B') // animated → legal attacker
    const atk = await s.client.query(
      'select 1 from public.game_combat_assignments where session_id = $1 and attacker_card_id = $2',
      [s.sessionId, forest])
    assert.equal(atk.rows.length, 1)
  })
})
// LA2 — a PLAIN land is still refused (assert.rejects LAST — single tx).
test('LA2 an unanimated land cannot attack', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const forest = await s.spawn('A', 'Forest Test', 'battlefield')
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await assert.rejects(() => s.as('A').declareAttacker(forest, 'B'), /Only creatures/)
  })
})
