// Josu Vess, Lich Knight (mig 211) — "Kicker {5}{B}. Menace. When Josu Vess
// enters, if it was kicked, create eight 2/2 black Zombie Knight creature
// tokens with menace." cast_card_from_hand's p_kicked pays the script's kicker
// in addition to the printed cost and stamps 'kicked' in the counter bag; the
// ETB conditional reads { counters: 'kicked', of: 'self' }.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx, asPlayer } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function knightTokens(s: Scenario): Promise<string[]> {
  const r = await s.client.query<{ id: string }>(
    `select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.zone = 'battlefield' and c.name = 'Zombie Knight Token'`,
    [s.sessionId],
  )
  return r.rows.map((row) => row.id)
}

// JV1 — unkicked: enters, no tokens.
test('JV1 unkicked cast makes no tokens', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const josu = await s.spawn('A', 'Josu Vess Test', 'hand')
    await s.setMana('A', { B: 2, C: 2 }) // {2}{B}{B}

    await s.as('A').castPermanent(josu)
    await s.as('A').resolveStack() // the permanent resolves
    await s.as('A').resolveStack() // the ETB trigger resolves (conditional gates off)

    assert.equal(await s.zoneOf(josu), 'battlefield')
    assert.equal((await knightTokens(s)).length, 0)
  })
})

// JV2 — kicked: pays {2}{B}{B} + {5}{B}, enters, makes eight menace Knights.
test('JV2 kicked cast creates eight Zombie Knights with menace', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const josu = await s.spawn('A', 'Josu Vess Test', 'hand')
    await s.setMana('A', { B: 3, C: 7 }) // {2}{B}{B} + {5}{B}

    await s.as('A').castPermanent(josu, { kicked: true })
    await s.as('A').resolveStack() // permanent
    await s.as('A').resolveStack() // ETB trigger → 8 tokens

    const tokens = await knightTokens(s)
    assert.equal(tokens.length, 8)
    const hasMenace = await asPlayer(s.client, s.players.A, async () => {
      const r = await s.client.query<{ r: boolean }>(
        'select public.card_has_menace($1, $2) as r', [s.sessionId, tokens[0]])
      return r.rows[0]!.r
    })
    assert.equal(hasMenace, true)
  })
})

// JV3 — kicking a card with no kicker cost is rejected.
test('JV3 kicking a kickerless card raises', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bear = await s.spawn('A', 'Goblin Raider Test', 'hand')
    await s.setMana('A', { R: 1 })

    await assert.rejects(
      () => s.as('A').castPermanent(bear, { kicked: true }),
      /no kicker cost/i,
    )
  })
})
