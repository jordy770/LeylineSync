// Mirror March (mig 354). "Whenever a nontoken creature you control enters, flip a
// coin until you lose. For each flip you won, create a token copy with haste, exile
// at the next end step." copy_permanent count:'coin_flip' loops random() until a
// loss. The test seeds Postgres' RNG (setseed) so the win count is deterministic.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function copyCount(s: Scenario): Promise<number> {
  const r = await s.client.query<{ n: string }>(
    `select count(*)::int as n from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.zone = 'battlefield' and gc.is_token = true and c.name = 'Vampire Bear Test'`,
    [s.sessionId])
  return Number(r.rows[0].n)
}

// MM1 — a seeded RNG yields a deterministic, positive number of hasty copies.
test('MM1 coin-flip copies are created (seeded)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Mirror March Test', 'battlefield')

    // Seed the RNG so the flip-until-lose loop is deterministic: -0.1 wins exactly
    // one flip (random 0.278 < 0.5, then 0.943 >= 0.5) → one copy.
    await s.client.query('select setseed(-0.1)')
    await s.spawnCreature('A', 'Vampire Bear Test') // a nontoken creature enters
    await s.as('A').resolveStack()

    assert.equal(await copyCount(s), 1, 'one coin-flip win → one copy')
    const tok = (await s.client.query<{ id: string }>(
      `select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
       where gc.session_id = $1 and gc.is_token = true and c.name = 'Vampire Bear Test' limit 1`,
      [s.sessionId])).rows[0]
    assert.equal(await s.continuousEffectCount(tok.id, 'haste'), 1, 'the copy has haste')
  })
})

// MM2 — a seed that loses the first flip makes zero copies.
test('MM2 losing the first flip makes no copies', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Mirror March Test', 'battlefield')

    // 0.456 loses the first flip (random 0.622 >= 0.5) → no copies.
    await s.client.query('select setseed(0.456)')
    await s.spawnCreature('A', 'Vampire Bear Test')
    await s.as('A').resolveStack()

    assert.equal(await copyCount(s), 0, 'lost the first flip → no copies')
  })
})
