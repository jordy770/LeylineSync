// Mirage Phalanx (no migration — reuses copy_self + begin_combat + cleanup_at_end_
// combat). APPROXIMATION: soulbond pairing is not modelled; the "at the beginning
// of combat, create a haste copy, exile at end of combat" ability is always on
// rather than only while paired.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// MP1 — at the beginning of combat it makes a hasty copy of itself, gone at end of combat.
test('MP1 begin-combat hasty self-copy, exiled at end of combat', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawnCreature('A', 'Mirage Phalanx Test')

    await s.setTurn({ phase: 'combat', step: 'beginning_of_combat', active: 'A', priority: 'A' })
    while (await s.topStackItem()) await s.as('A').resolveStack()

    const after = await s.client.query<{ id: string }>(
      `select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
       where gc.session_id = $1 and gc.zone = 'battlefield' and gc.is_token = true and c.name = 'Mirage Phalanx Test'`,
      [s.sessionId])
    assert.equal(after.rows.length, 1, 'a hasty self-copy was made')
    assert.equal(await s.continuousEffectCount(after.rows[0].id, 'haste'), 1, 'the copy has haste')

    await s.setTurn({ phase: 'combat', step: 'end_of_combat', active: 'A', priority: 'A' })
    await s.as('A').advanceStep()
    const gone = await s.client.query<{ n: string }>(
      `select count(*)::int as n from public.game_cards gc join public.cards c on c.id = gc.card_id
       where gc.session_id = $1 and gc.zone = 'battlefield' and gc.is_token = true and c.name = 'Mirage Phalanx Test'`,
      [s.sessionId])
    assert.equal(Number(gone.rows[0].n), 0, 'the copy is exiled at end of combat')
  })
})
