// mig 401 — card_drawn watcher: every real draw (draw effect, natural draw,
// cycling) bumps note_card_drawn and broadcasts with the 1-based per-turn
// index. filter.draw_number fires on exactly the Nth draw (Ethereal
// Investigator); filter.off_turn skips the subject player's own turn and
// once_per_turn caps it (Tataru Taru's Scions' Secretary).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function tokens(s: Scenario, seat: 'A' | 'B', name: string): Promise<number> {
  const r = await s.client.query(
    `select count(*)::int as n from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.controller_player_id = $2 and gc.zone = 'battlefield' and c.name = $3`,
    [s.sessionId, s.players[seat], name])
  return r.rows[0].n
}

async function stock(s: Scenario, seat: 'A' | 'B', n: number): Promise<void> {
  for (let i = 0; i < n; i++) await s.spawn(seat, 'Goblin Raider Test', 'library')
}

// CD1 — exactly the second draw makes a Spirit: draw 1 (nothing), draw 2
// (Spirit), draw 3 (still one Spirit).
test('CD1 draw_number fires on exactly the Nth draw', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Second Draw Spirit Test')
    await stock(s, 'A', 3)

    await s.as('A').castSpellEffect([{ type: 'draw', amount: 1 }])
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()
    assert.equal(await tokens(s, 'A', 'Spirit Token'), 0)

    await s.as('A').castSpellEffect([{ type: 'draw', amount: 1 }])
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()
    assert.equal(await tokens(s, 'A', 'Spirit Token'), 1)

    await s.as('A').castSpellEffect([{ type: 'draw', amount: 1 }])
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()
    assert.equal(await tokens(s, 'A', 'Spirit Token'), 1)
  })
})

// CD2 — off_turn + once_per_turn: an opponent drawing on YOUR watcher-owner's
// turn mints one tapped Treasure, and only once; the active player's own draw
// never triggers it.
test('CD2 off_turn watcher pays once per turn on opponents\' off-turn draws', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    // A's turn; A controls the Secretary; B is the off-turn opponent.
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Off Turn Secretary Test')
    await stock(s, 'A', 2)
    await stock(s, 'B', 2)

    // A (active player) draws: controller filter 'opponent' skips it.
    await s.as('A').castSpellEffect([{ type: 'draw', amount: 1 }])
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()
    assert.equal(await tokens(s, 'A', 'Treasure Token'), 0)

    // B draws off-turn (via A's spell making each opponent draw): one Treasure.
    await s.as('A').castSpellEffect([{ type: 'draw', recipient: 'each_opponent', amount: 2 }])
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()
    assert.equal(await tokens(s, 'A', 'Treasure Token'), 1) // once_per_turn caps the 2nd draw

    const r = await s.client.query(
      `select gc.is_tapped from public.game_cards gc join public.cards c on c.id = gc.card_id
       where gc.session_id = $1 and c.name = 'Treasure Token' limit 1`, [s.sessionId])
    assert.equal(r.rows[0].is_tapped, true)
  })
})
