// Job select (mig 297): when a "Job select" Equipment enters, it creates a 1/1
// Hero creature token and attaches itself to that token. The equipped-creature
// bonus rides an affected:'equipped' continuous effect.
//
// Job Equip Test: Job select; equipped creature gets +1/+0.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// JS1 — the Equipment enters, spawns a Hero token, attaches to it, and the
// equipped bonus (+1/+0) applies (1/1 Hero becomes 2/1).
test('JS1 job select creates a Hero token and equips it', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const equip = await s.spawn('A', 'Job Equip Test', 'battlefield') // fires ETB job_select
    await s.as('A').resolveStack()

    const hero = await client.query(
      `select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
       where gc.session_id = $1 and c.name = 'Hero Token' and gc.zone = 'battlefield'`,
      [s.sessionId],
    )
    assert.equal(hero.rows.length, 1)                                // Hero token created
    const heroId = hero.rows[0].id as string

    const att = await client.query('select attached_to from public.game_cards where id = $1', [equip])
    assert.equal(att.rows[0].attached_to, heroId)                    // Equipment attached to it
    assert.equal(await s.effectivePower(heroId), 2)                  // 1/1 + equip +1/+0
  })
})
