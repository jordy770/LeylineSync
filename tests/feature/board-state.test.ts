// mig 371 — get_board_state bundles the big-screen board view into one jsonb
// payload (replacing useBoardGameState's ~8 reads per refresh). Locks the contract.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx, asPlayer } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

test('BS1 get_board_state returns every section with joined card data', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const a = await s.spawnCreature('A', 'Dino Grunt Test')
    const b = await s.spawnCreature('B', 'Air Elemental Test') // another player's permanent

    const r = await asPlayer(s.client, s.playerId('A'), async () => {
      const res = await s.client.query<{ r: Record<string, unknown> }>(
        'select public.get_board_state($1) as r',
        [s.sessionId],
      )
      return res.rows[0].r
    })

    for (const key of [
      'session', 'turn_state', 'players', 'combat_assignments', 'stack_items',
      'commander_damage', 'status_effects', 'board_cards',
    ]) {
      assert.ok(key in r, `missing section: ${key}`)
    }

    // The board shows ALL players' battlefield permanents, with catalog names joined.
    const board = r.board_cards as { id: string; name: string }[]
    assert.ok(board.find((c) => c.id === a && c.name === 'Dino Grunt Test'), 'A creature missing')
    assert.ok(board.find((c) => c.id === b && c.name === 'Air Elemental Test'), 'B creature missing')

    // A non-member cannot read the board.
    await assert.rejects(
      asPlayer(s.client, s.playerId('C'), () =>
        s.client.query('select public.get_board_state($1)', [s.sessionId]),
      ),
    )
  })
})
