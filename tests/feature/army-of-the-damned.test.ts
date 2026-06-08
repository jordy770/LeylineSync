// Army of the Damned — "Create thirteen 2/2 black Zombie creature tokens that are
// tapped. Flashback {7}{B}{B}{B}." Exercises tapped token creation (the create_token
// `tapped` flag) and flashback (cast from the graveyard for an alternate cost, then
// exile the card).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// The token-creation program (what cast_spell_effect stores; the flashback cost is read
// from the card's script server-side, not from this array).
const ARMY_ACTIONS = [{ type: 'create_token', token: 'Zombie Army Token', count: 13, tapped: true }]

async function zombieTokens(s: Scenario, seat: 'A' | 'B'): Promise<{ total: number; tapped: number }> {
  const r = await s.client.query<{ total: string; tapped: string }>(
    `select count(*)::text as total,
            count(*) filter (where g.is_tapped)::text as tapped
     from public.game_cards g join public.cards c on c.id = g.card_id
     where g.session_id = $1 and g.controller_player_id = $2
       and g.zone = 'battlefield' and c.name = 'Zombie Army Token'`,
    [s.sessionId, s.playerId(seat)],
  )
  return { total: Number(r.rows[0]!.total), tapped: Number(r.rows[0]!.tapped) }
}

// ARMY1 — cast from hand: 13 tapped Zombie tokens; the spell goes to the graveyard.
test('ARMY1 creates thirteen tapped Zombies and goes to the graveyard', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const army = await s.spawn('A', 'Army of the Damned Test', 'hand')
    await s.setMana('A', { B: 7 }) // {5}{B}{B}

    await s.as('A').castSpellEffect(ARMY_ACTIONS, army)
    await s.as('A').resolveStack()

    const tokens = await zombieTokens(s, 'A')
    assert.equal(tokens.total, 13)
    assert.equal(tokens.tapped, 13) // all enter tapped
    assert.equal(await s.zoneOf(army), 'graveyard')
  })
})

// ARMY2 — flashback from the graveyard: pays the flashback cost, makes 13 more, exiles.
test('ARMY2 flashback casts from the graveyard, then exiles the card', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const army = await s.spawn('A', 'Army of the Damned Test', 'graveyard')
    await s.setMana('A', { B: 10 }) // flashback {7}{B}{B}{B}

    await s.as('A').castSpellEffect(ARMY_ACTIONS, army)
    assert.equal(await s.zoneOf(army), 'exile') // exiled on cast, not back to graveyard
    await s.as('A').resolveStack()

    const tokens = await zombieTokens(s, 'A')
    assert.equal(tokens.total, 13)
    assert.equal(tokens.tapped, 13)
  })
})

// ARMY3 — a graveyard card WITHOUT a flashback cost cannot be cast from the graveyard.
test('ARMY3 a non-flashback card cannot be cast from the graveyard', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const beast = await s.spawn('A', 'Beast Within Test', 'graveyard') // no flashback in its script

    // The raising RPC aborts the tx; a savepoint lets the test finish.
    await s.client.query('savepoint army3')
    await assert.rejects(
      () => s.as('A').castSpellEffect([{ type: 'draw', amount: 1 }], beast),
      /cannot be cast from your graveyard/,
    )
    await s.client.query('rollback to savepoint army3')
    assert.equal(await s.zoneOf(beast), 'graveyard') // unmoved
  })
})
