// mig 399 — token_created watcher event + tokens_created_this_turn count:
// fire_token_created (AFTER INSERT on battlefield game_cards rows) bumps the
// creator's turn-stamped tally and broadcasts 'token_created' (Mirkwood Bats);
// the count gates activated abilities (Idol of Oblivion's draw).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function life(s: Scenario, seat: 'A' | 'B'): Promise<number> {
  const r = await s.client.query(
    `select life_total from public.game_session_players where session_id = $1 and player_id = $2`,
    [s.sessionId, s.players[seat]])
  return r.rows[0].life_total
}

// TK1 — creating a token fires the watcher for its creator only.
test('TK1 token_created watcher drains on your token, not theirs', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Token Toll Test')
    const lifeB = await life(s, 'B')

    await s.as('A').castSpellEffect([{ type: 'create_token', token: 'Treasure Token', count: 1 }])
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()

    assert.equal(await life(s, 'B'), lifeB - 1)
  })
})

// TK2 — the tokens_created_this_turn gate: blocked before a token is made,
// open afterwards. The failing activation is the LAST action (aborted-tx rule).
test('TK2 tokens_created_this_turn gates an activated ability', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const idol = await s.spawn('A', 'Token Gated Draw Test', 'battlefield')
    await s.spawn('A', 'Goblin Raider Test', 'library')

    await s.as('A').castSpellEffect([{ type: 'create_token', token: 'Treasure Token', count: 1 }])
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()

    await s.as('A').activate(idol, 0)
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()
    const r = await s.client.query(
      `select count(*)::int as n from public.game_cards where session_id = $1 and owner_id = $2 and zone = 'hand'`,
      [s.sessionId, s.players.A])
    assert.equal(r.rows[0].n, 1)
  })
})

// TK3 — without a token created this turn the gate rejects.
test('TK3 the gate rejects when no token was created this turn', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const idol = await s.spawn('A', 'Token Gated Draw Test', 'battlefield')
    await s.spawn('A', 'Goblin Raider Test', 'library')

    await assert.rejects(s.as('A').activate(idol, 0))
  })
})
