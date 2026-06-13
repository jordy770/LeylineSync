// mig 274 — watcher commander filter: Norn's Choirmaster proliferates only
// for commanders.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// IS1 — a plain creature entering does nothing; a commander entering parks
// the proliferate decision.
test('IS1 Choirmaster fires only for commanders', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Norns Choirmaster Test')

    await s.spawnCreature('A', 'Dino Grunt Test') // not a commander — no trigger
    const none = await s.client.query(
      `select 1 from public.game_stack_items where session_id = $1 and status = 'pending'`,
      [s.sessionId])
    assert.equal(none.rows.length, 0)

    const cmdr = await s.spawnCreature('A', 'Breya Shaper Test')
    await s.client.query(
      'update public.game_cards set is_commander = true where id = $1', [cmdr])
    // Re-fire the entry by bouncing through hand (is_commander now set).
    await s.client.query(
      `update public.game_cards set zone = 'hand' where id = $1`, [cmdr])
    await s.client.query(
      `update public.game_cards set zone = 'battlefield' where id = $1`, [cmdr])

    const items = await s.client.query<{ payload: { effects: Array<{ type: string }> } }>(
      `select payload from public.game_stack_items
       where session_id = $1 and status = 'pending' and action_type = 'triggered_ability'`,
      [s.sessionId])
    assert.ok(items.rows.some((r) => r.payload.effects.some((e) => e.type === 'proliferate')))
  })
})
