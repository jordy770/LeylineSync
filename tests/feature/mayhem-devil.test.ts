// Mayhem Devil — already engine-supported once mig 341 added the
// permanent_sacrificed watcher event. "Whenever a player sacrifices a permanent,
// this deals 1 damage to any target." Script-only (a targeted deal_damage trigger
// on permanent_sacrificed); no new engine code.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// MD1 — sacrificing a creature pings a chosen target for 1.
test('MD1 a sacrifice pings a chosen target for 1', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Mayhem Devil Test')
    const outlet = await s.spawnCreature('A', 'Free Sac Test')
    const fodder = await s.spawnCreature('A', 'Grave Shambler Test')
    const victim = await s.spawnCreature('B', 'Grave Shambler Test') // 2/2 damage target

    await s.as('A').activate(outlet, 0, { targetCardId: fodder }) // sacrifice → fires the watcher
    assert.equal(await s.zoneOf(fodder), 'graveyard')

    // Work the stack: the Free Sac draw resolves, then the Mayhem Devil trigger
    // surfaces awaiting an "any target" pick.
    let top
    while ((top = await s.topStackItem())) {
      const payload = top.payload as Record<string, unknown>
      if (top.action_type === 'triggered_ability' && !payload.target_card_id) {
        await s.as('A').chooseTriggerTarget(top.id, victim)
      } else {
        await s.as('A').resolveStack()
      }
    }

    assert.equal((await s.cardState(victim)).damage_marked, 1, 'victim took 1 damage')
  })
})
