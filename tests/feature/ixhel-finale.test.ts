// mig 275 — Ixhel finale: the attack-tax system (Ghostly Prison) and the
// graveyard-to-library-top pick (Noxious Revival).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// IF1 — Ghostly Prison: an attacker without mana is refused; with {2} in the
// pool the attack goes through and the pool is drained.
test('IF1 Ghostly Prison taxes each attacker', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawn('A', 'Ghostly Prison Test', 'battlefield')
    const raider = await s.spawnCreature('B', 'Air Elemental Test')
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'B', priority: 'B' })

    await assert.rejects(
      () => s.as('B').declareAttacker(raider, 'A'),
      /attack tax/)
  })
})

// IF2 — paying the tax: with mana in the pool the attack is allowed.
test('IF2 a funded attacker pays the prison toll', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawn('A', 'Ghostly Prison Test', 'battlefield')
    const raider = await s.spawnCreature('B', 'Air Elemental Test')
    await s.setMana('B', { C: 1, G: 1 })
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'B', priority: 'B' })

    await s.as('B').declareAttacker(raider, 'A')

    const pool = await s.client.query<{ mana_pool: Record<string, number> }>(
      'select mana_pool from public.game_players where session_id = $1 and player_id = $2',
      [s.sessionId, s.players.B])
    const left = Object.values(pool.rows[0]!.mana_pool).reduce((a, b) => a + b, 0)
    assert.equal(left, 0) // both mana paid the toll
  })
})

// IF3 — Noxious Revival: a graveyard card lands on top of its owner's library.
test('IF3 Noxious Revival tops the library', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('B', 'Wastes Test', 'library') // existing library card
    const corpse = await s.spawn('B', 'Dino Grunt Test', 'graveyard')

    await s.as('A').castSpellEffect([{ type: 'graveyard_to_library_top' }])
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'graveyard_to_top_pick')
    await s.as('A').submitDecision(d!.id, { chosen: [corpse] })

    const top = await s.client.query<{ id: string }>(
      `select id from public.game_cards
       where session_id = $1 and owner_id = $2 and zone = 'library'
       order by zone_position asc, id asc limit 1`,
      [s.sessionId, s.players.B])
    assert.equal(top.rows[0]!.id, corpse) // the corpse is now the top card
  })
})
