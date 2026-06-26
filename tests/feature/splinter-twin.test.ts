// Splinter Twin (mig 358). "Enchant creature. Enchanted creature has '{T}: create a
// token copy of this creature with haste. Exile that token at the beginning of the
// next end step.'" Built on granted_ability (mig 357): the Aura grants the host an
// ACTIVATED ability (copy_self), and activate_ability now routes copy_self.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// ST1 — the enchanted creature can tap to make a hasty copy of itself.
test('ST1 the enchanted creature copies itself when tapped', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const twin = await s.spawn('A', 'Splinter Twin Test', 'battlefield')
    const bear = await s.spawnCreature('A', 'Vampire Bear Test')

    // Attach the Aura to the creature (cast/attach itself is not under test).
    await s.client.query('update public.game_cards set attached_to = $1 where id = $2', [bear, twin])
    await s.as('A').rebuild() // register the granted_ability on the host

    await s.as('A').activate(bear, 0) // {T}: copy_self
    while (await s.topStackItem()) await s.as('A').resolveStack()

    const toks = await s.client.query<{ id: string }>(
      `select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
       where gc.session_id = $1 and gc.zone = 'battlefield' and gc.is_token = true and c.name = 'Vampire Bear Test'`,
      [s.sessionId])
    assert.equal(toks.rows.length, 1, 'a copy of the enchanted creature was made')
    assert.equal(await s.continuousEffectCount(toks.rows[0].id, 'haste'), 1, 'the copy has haste')
    assert.equal((await s.cardState(bear)).is_tapped, true, 'the host tapped for the ability')
  })
})
