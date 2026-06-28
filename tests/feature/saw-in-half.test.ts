// Saw in Half (mig 356). "Destroy target creature. If that creature dies this way,
// its controller creates two tokens that are copies of it, except their power and
// toughness are half (rounded up)." A saw_in_half effect grants a dies-trigger
// (copy_self ×2 with the half P/T baked from current effective P/T) then destroys
// the creature, so the copies appear only on an actual death.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// SW1 — destroying a 2/2 makes two 1/1 copies under its controller.
test('SW1 the creature dies and its controller gets two half-size copies', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const victim = await s.spawnCreature('B', 'Vampire Bear Test') // B controls a 2/2

    await s.as('A').castSpellEffect([{ type: 'saw_in_half', target_type: 'creature' }], null, null, victim)
    while (await s.topStackItem()) await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(victim), 'graveyard', 'the original was destroyed')
    const toks = await s.client.query<{ id: string }>(
      `select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
       where gc.session_id = $1 and gc.zone = 'battlefield' and gc.is_token = true and c.name = 'Vampire Bear Test'
         and coalesce(gc.controller_player_id, gc.owner_id) = $2`,
      [s.sessionId, s.playerId('B')])
    assert.equal(toks.rows.length, 2, 'two copies under the controller (B)')
    assert.equal(await s.effectivePower(toks.rows[0].id), 1, 'half power (ceil(2/2)=1)')
    assert.equal(await s.effectiveToughness(toks.rows[0].id), 1, 'half toughness')
  })
})
