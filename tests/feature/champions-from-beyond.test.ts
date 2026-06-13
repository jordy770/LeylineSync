// Champions from Beyond (mig 300, Stage A): an {X} permanent whose ETB creates
// X 1/1 Hero tokens. The chosen X is stamped on the card at cast
// (cast_card_from_hand p_x_value -> counters.x) and read by create_token count:'X'.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// CH1 — casting with X=3 makes three Hero tokens on resolution.
test('CH1 Champions ETB creates X Hero tokens', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const champ = await s.spawn('A', 'Champions Test', 'hand')

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { W: 1, C: 3 })

    await s.as('A').castPermanent(champ, { x: 3 })
    await s.as('A').resolveStack() // Champions resolves -> battlefield, ETB enqueued
    await s.as('A').resolveStack() // the ETB create-token resolves

    const heroes = await client.query(
      `select count(*)::int n from public.game_cards gc join public.cards c on c.id = gc.card_id
       where gc.session_id = $1 and c.name = 'Hero Token' and gc.zone = 'battlefield'`,
      [s.sessionId],
    )
    assert.equal(heroes.rows[0].n, 3)
  })
})
