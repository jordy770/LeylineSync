// Jaxis, the Troublemaker (mig 349). Activated copy (reusing Orthion's path) where
// the copy token gains haste, end-step cleanup (mig 347), AND "When this token
// dies, draw a card" — via the new except.dies_effect that stamps a
// granted_dies_effect on the copy (mig 344 fires it on death). Blitz is omitted.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// JX1 — copy a creature; when the copy dies it draws a card.
test('JX1 the copy draws a card when it dies', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const jaxis = await s.spawnCreature('A', 'Jaxis Test')
    const bear = await s.spawnCreature('A', 'Vampire Bear Test')
    const discard = await s.spawn('A', 'Air Elemental Test', 'hand') // a card to discard
    await s.spawn('A', 'Air Elemental Test', 'library') // a card to draw on death
    await s.setMana('A', { R: 1 })

    await s.as('A').activate(jaxis, 0, { targetCardId: discard }) // discard cost rides target_card_id
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    assert.equal(d?.decision_type, 'copy_permanent')
    await s.as('A').submitDecision(d!.id, { chosen: [bear] })

    const tok = (await s.client.query<{ id: string }>(
      `select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
       where gc.session_id = $1 and gc.zone = 'battlefield' and gc.is_token = true and c.name = 'Vampire Bear Test'`,
      [s.sessionId])).rows[0]
    assert.ok(tok, 'a copy token was created')
    assert.equal(await s.continuousEffectCount(tok.id, 'haste'), 1, 'copy has haste')

    const handBefore = await s.zoneCount('A', 'hand')
    await s.as('A').putInGraveyard(tok.id) // the token dies
    while (await s.topStackItem()) await s.as('A').resolveStack()

    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 1, 'drew a card on the token dying')
  })
})
