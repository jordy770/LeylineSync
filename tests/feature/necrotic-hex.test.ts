// Necrotic Hex (mig 198) — "Each player sacrifices six creatures of their choice.
// You create six tapped 2/2 black Zombie tokens." Exercises who:'each_player' (the
// caster sacrifices too, in seat order) followed by a fixed tapped-token payoff.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function zombieTokens(s: Scenario): Promise<{ total: number; tapped: number }> {
  const r = await s.client.query<{ total: string; tapped: string }>(
    `select count(*) as total, count(*) filter (where gc.is_tapped) as tapped
     from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.controller_player_id = $2 and gc.zone = 'battlefield' and c.name = 'Zombie Token'`,
    [s.sessionId, s.players.A],
  )
  return { total: Number(r.rows[0]!.total), tapped: Number(r.rows[0]!.tapped) }
}

// NH1 — both players (incl. the caster) sacrifice, then the caster gets six tapped Zombies.
test('NH1 each player sacrifices, then six tapped Zombies are created', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 2)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const a1 = await s.spawnCreature('A', 'Grave Shambler Test')
    const a2 = await s.spawnCreature('A', 'Grave Shambler Test')
    const b1 = await s.spawnCreature('B', 'Grave Shambler Test')

    await s.as('A').castSpellEffect([
      { type: 'sacrifice', who: 'each_player', count: 6 },
      { type: 'create_token', token: 'Zombie Token', count: 6, tapped: true },
    ])
    await s.as('A').resolveStack()

    // The caster (active player) is prompted first, then the opponent.
    let d = await s.pendingDecision()
    assert.equal(d?.deciding_player_id, s.playerId('A'))
    await s.as('A').submitDecision(d!.id, { chosen: [a1, a2] }) // A had 2

    d = await s.pendingDecision()
    assert.equal(d?.deciding_player_id, s.playerId('B'))
    await s.as('B').submitDecision(d!.id, { chosen: [b1] }) // B had 1

    assert.equal(await s.zoneOf(a1), 'graveyard')
    assert.equal(await s.zoneOf(b1), 'graveyard')
    const tok = await zombieTokens(s)
    assert.equal(tok.total, 6) // six tokens
    assert.equal(tok.tapped, 6) // all tapped
  })
})
