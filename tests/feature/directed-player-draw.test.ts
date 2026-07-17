// Directed target-player effects — "Target player draws X …" (Blue Sun's Zenith,
// Damnable Pact, Compulsive Research). Modeled with the existing choose_player,
// which runs its inner effects AS the chosen player, so draw / lose_life / discard
// land on the picked player (an opponent for a deck-out or a kill), not just the
// caster. This test proves the redirect against a chosen opponent.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function handCount(s: Scenario, seat: 'A' | 'B'): Promise<number> {
  const r = await s.client.query<{ n: string }>(
    `select count(*)::int as n from public.game_cards
     where session_id = $1 and owner_id = $2 and zone = 'hand'`,
    [s.sessionId, s.players[seat]])
  return Number(r.rows[0]!.n)
}
async function life(s: Scenario, seat: 'A' | 'B'): Promise<number> {
  const r = await s.client.query<{ life_total: number }>(
    `select life_total from public.game_session_players where session_id = $1 and player_id = $2`,
    [s.sessionId, s.players[seat]])
  return r.rows[0]!.life_total
}

// DIR1 — Damnable Pact aimed at an opponent: that player draws X and loses X life.
test('DIR1 target-player draw + lose_life redirect to the chosen opponent', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    for (let i = 0; i < 4; i++) await s.spawn('B', 'Forest Test', 'library') // B's deck to draw
    const bHand0 = await handCount(s, 'B')
    const bLife0 = await life(s, 'B')
    const aHand0 = await handCount(s, 'A')

    // "Target player draws 2 and loses 2 life" (Damnable Pact with X=2).
    await s.as('A').castSpellEffect([
      { type: 'choose_player', filter: 'any', effects: [
        { type: 'draw', amount: 2 }, { type: 'lose_life', amount: 2 }] }])
    await s.as('A').resolveStack()

    const d = await s.pendingDecision()
    assert.equal(d?.decision_type, 'choose_player')
    await s.as('A').submitDecision(d!.id, { player_id: s.players.B }) // aim at the opponent (applies the effects)

    assert.equal(await handCount(s, 'B'), bHand0 + 2) // opponent drew two
    assert.equal(await life(s, 'B'), bLife0 - 2)      // opponent lost two life
    assert.equal(await handCount(s, 'A'), aHand0)     // caster untouched
  })
})
