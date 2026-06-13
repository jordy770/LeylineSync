// mig 241 — Farseek + Flooded Grove.
//   • search_library filter.type_line_any: OR over several type words
//     ("a Plains, Island, Swamp, or Mountain card" — note: NOT Forest).
//   • Flooded Grove is script-only: a {G/U} hybrid activation cost on a mana
//     ability (pay_mana_cost's hybrid default pays the held colour).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

const FARSEEK_ACTIONS = [
  {
    type: 'search_library',
    count: 1,
    to: 'battlefield',
    tapped: true,
    filter: { type_line_any: ['Plains', 'Island', 'Swamp', 'Mountain'] },
  },
]

// FS1 — Farseek offers an Island but not a plain (typeless) land, and the
// pick lands on the battlefield tapped.
test('FS1 Farseek type_line_any offers only the listed land types', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const island = await s.spawn('A', 'Island Test', 'library') // Basic Land - Island
    await s.spawn('A', 'Wastes Test', 'library') // Basic Land (no listed type)

    await s.as('A').castSpellEffect(FARSEEK_ACTIONS)
    await s.as('A').resolveStack()

    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'search_library')
    const offered = (d!.options as { game_card_id: string }[]).map((o) => o.game_card_id)
    assert.deepEqual(offered, [island])
    await s.as('A').submitDecision(d!.id, { chosen: [island] })

    const row = await s.client.query<{ zone: string; is_tapped: boolean }>(
      'select zone, is_tapped from public.game_cards where id = $1', [island])
    assert.equal(row.rows[0]!.zone, 'battlefield')
    assert.equal(row.rows[0]!.is_tapped, true)
  })
})

// FG1 — Flooded Grove: {G/U}, {T}: Add {U}{U}, paying the hybrid with U.
test('FG1 Flooded Grove hybrid-cost mana ability nets one extra mana', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const grove = await s.spawn('A', 'Flooded Grove Test', 'battlefield')
    await s.setMana('A', { U: 1 })

    await s.as('A').activateMana(grove, 3) // {G/U},{T}: Add {U}{U} — pays the U
    const pool = await s.client.query<{ mana_pool: Record<string, number> }>(
      'select mana_pool from public.game_players where session_id = $1 and player_id = $2',
      [s.sessionId, s.players.A])
    assert.equal(pool.rows[0]!.mana_pool.U, 2)
    assert.equal(pool.rows[0]!.mana_pool.G, 0)
  })
})
