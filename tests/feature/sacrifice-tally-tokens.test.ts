// Syphon Flesh (mig 191) — "Each other player sacrifices a creature. You create a
// 2/2 black Zombie token for each creature sacrificed this way." A create_token with
// count:{count:'sacrificed_this_way'} reads a tally that submit_decision accumulates
// on the spell's stack item as each opponent sacrifices through the edict chain.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function zombieTokens(s: Scenario, seat: 'A' | 'B' | 'C'): Promise<number> {
  const res = await s.client.query<{ n: string }>(
    `select count(*) as n from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.controller_player_id = $2
       and gc.zone = 'battlefield' and c.name = 'Zombie Token'`,
    [s.sessionId, s.players[seat]],
  )
  return Number(res.rows[0]?.n ?? 0)
}

const SYPHON = [
  { type: 'sacrifice', who: 'each_opponent' },
  { type: 'create_token', token: 'Zombie Token', count: { count: 'sacrificed_this_way' } },
]

// SF1 — two opponents each sacrifice → the caster gets two Zombie tokens.
test('SF1 creates one Zombie per creature sacrificed (two opponents)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 3)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bCre = await s.spawnCreature('B', 'Deathtouch Viper Test')
    const cCre = await s.spawnCreature('C', 'Deathtouch Viper Test')

    await s.as('A').castSpellEffect(SYPHON)
    await s.as('A').resolveStack()

    let d = await s.pendingDecision()
    await s.as('B').submitDecision(d!.id, { chosen: [bCre] })
    d = await s.pendingDecision()
    await s.as('C').submitDecision(d!.id, { chosen: [cCre] })

    assert.equal(await s.zoneOf(bCre), 'graveyard')
    assert.equal(await s.zoneOf(cCre), 'graveyard')
    assert.equal(await zombieTokens(s, 'A'), 2) // one token per sacrifice
  })
})

// SF2 — an opponent with no creature is skipped → only one sacrifice → one token.
test('SF2 tokens scale with actual sacrifices (one opponent empty)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 3)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bCre = await s.spawnCreature('B', 'Deathtouch Viper Test') // C controls nothing

    await s.as('A').castSpellEffect(SYPHON)
    await s.as('A').resolveStack()

    const d = await s.pendingDecision()
    await s.as('B').submitDecision(d!.id, { chosen: [bCre] })

    assert.equal(await s.pendingDecision(), null) // C skipped
    assert.equal(await zombieTokens(s, 'A'), 1) // exactly one token
  })
})
