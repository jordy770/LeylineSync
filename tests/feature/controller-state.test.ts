// mig 370 — get_controller_state bundles the whole controller view into one jsonb
// payload (replacing ~19 PostgREST reads per game action). This locks the contract:
// every section is present and the card sections carry their joined catalog fields.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx, asPlayer } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

test('CS1 get_controller_state returns every section with joined card data', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const creature = await s.spawnCreature('A', 'Dino Grunt Test') // battlefield, owned by A
    await s.spawn('A', 'Air Elemental Test', 'hand') // a hand card for A
    await s.setMana('A', { G: 2 })

    const r = await asPlayer(s.client, s.playerId('A'), async () => {
      const res = await s.client.query<{ r: Record<string, unknown> }>(
        'select public.get_controller_state($1, $2) as r',
        [s.sessionId, s.playerId('A')],
      )
      return res.rows[0].r
    })

    // Every section the hook destructures is present.
    for (const key of [
      'session', 'turn_state', 'players', 'combat_action_state', 'combat_assignments',
      'stack_items', 'pending_decisions', 'mana_pool', 'restricted_mana',
      'continuous_effects', 'commander_damage', 'board_cards', 'controller_cards',
    ]) {
      assert.ok(key in r, `missing section: ${key}`)
    }

    // Board card carries the catalog name joined in SQL (no separate lookup).
    const board = r.board_cards as { id: string; name: string }[]
    const dino = board.find((b) => b.id === creature)
    assert.ok(dino, 'spawned creature not in board_cards')
    assert.equal(dino!.name, 'Dino Grunt Test')

    // Controller cards include both A's permanents and hand, with nested `cards`.
    const ctrl = r.controller_cards as { card_id: string; cards: { name: string } | null }[]
    assert.ok(ctrl.length >= 2, 'expected at least the creature + hand card')
    assert.ok(ctrl.every((c) => c.cards === null || typeof c.cards.name === 'string'))

    // mana_pool reflects what we set.
    assert.equal((r.mana_pool as Record<string, number>).G, 2)

    // Security: another player cannot read A's controller state.
    await assert.rejects(
      asPlayer(s.client, s.playerId('B'), () =>
        s.client.query('select public.get_controller_state($1, $2)', [s.sessionId, s.playerId('A')]),
      ),
    )
  })
})
