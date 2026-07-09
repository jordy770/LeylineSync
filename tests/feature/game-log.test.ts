// mig 387 — the game log grows turn/combat/death/winner context.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

const logLines = async (s: Scenario) => {
  const r = await s.client.query<{ description: string; action_type: string }>(
    'select description, action_type from public.game_action_log where session_id = $1 order by created_at',
    [s.sessionId])
  return r.rows
}

// GL1 — attack, block and the resulting death all land in the log.
test('GL1 combat writes attack, block and death lines', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const raider = await s.spawnCreature('A', 'Dino Grunt Test') // 3/3
    const wall = await s.spawnCreature('B', 'Air Elemental Test') // 4/4 flier — kills the 3/3

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(raider, 'B')
    await s.setTurn({ phase: 'combat', step: 'declare_blockers', active: 'A', priority: 'B' })
    await s.as('B').declareBlocker(wall, raider)
    await s.setTurn({ phase: 'combat', step: 'combat_damage', active: 'A', priority: 'A' })
    await s.as('A').resolveCombat()

    const lines = (await logLines(s)).map((l) => l.description)
    assert.ok(lines.some((d) => d.startsWith('attacks ') && d.includes('Dino Grunt Test')), `no attack line in: ${lines}`)
    assert.ok(lines.includes('blocks Dino Grunt Test with Air Elemental Test'), `no block line in: ${lines}`)
    assert.ok(lines.includes('Dino Grunt Test dies'), `no death line in: ${lines}`)
  })
})

// GL2 — a turn_number change and a finished session hit the log.
test('GL2 turn markers and the winner are logged', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.client.query(
      'update public.game_turn_state set turn_number = turn_number + 1 where session_id = $1',
      [s.sessionId])
    await s.client.query(
      `update public.game_sessions set status = 'finished', winner_player_id = $2 where id = $1`,
      [s.sessionId, s.players.A])

    const lines = await logLines(s)
    assert.ok(lines.some((l) => l.action_type === 'turn' && /^turn \d+ begins$/.test(l.description)), 'no turn line')
    assert.ok(lines.some((l) => l.action_type === 'game_end' && l.description === 'wins the game'), 'no winner line')
  })
})
