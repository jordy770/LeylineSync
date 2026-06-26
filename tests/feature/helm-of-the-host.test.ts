// Helm of the Host (mig 350). "At the beginning of combat on your turn, create a
// token that's a copy of equipped creature, except the token isn't legendary. That
// token gains haste." Uses the existing begin_combat event + a new copy_permanent
// target:'attached' (copy the source's equipped host). The non-legendary clause is
// not modelled (no type-removal).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// HH1 — at the beginning of combat, the equipped creature is copied (with haste).
test('HH1 begin combat makes a hasty copy of the equipped creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const helm = await s.spawn('A', 'Helm Test', 'battlefield')
    const bear = await s.spawnCreature('A', 'Vampire Bear Test')
    await s.setMana('A', { C: 5 })
    await s.as('A').equip(helm, bear, { generic: { C: 5 } })

    await s.setTurn({ phase: 'combat', step: 'beginning_of_combat', active: 'A', priority: 'A' })
    while (await s.topStackItem()) await s.as('A').resolveStack() // the begin-combat copy trigger

    const toks = await s.client.query<{ id: string }>(
      `select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
       where gc.session_id = $1 and gc.zone = 'battlefield' and gc.is_token = true and c.name = 'Vampire Bear Test'`,
      [s.sessionId])
    assert.equal(toks.rows.length, 1, 'one copy of the equipped creature')
    assert.equal(await s.continuousEffectCount(toks.rows[0].id, 'haste'), 1, 'copy has haste')
  })
})
