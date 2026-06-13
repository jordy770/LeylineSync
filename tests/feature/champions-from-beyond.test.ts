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

// CH2 — Light Party: attacking with 4+ creatures fires once (draws); 3 does not.
test('CH2 Light Party fires once when you attack with four or more creatures', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawnCreature('A', 'Champions Test')
    const atk = []
    for (let i = 0; i < 4; i++) atk.push(await s.spawnCreature('A', 'Air Elemental Test'))
    await s.spawn('A', 'Air Elemental Test', 'library')

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    const handBefore = await s.zoneCount('A', 'hand')

    await s.as('A').declareAttacker(atk[0], 'B')
    await s.as('A').declareAttacker(atk[1], 'B')
    await s.as('A').declareAttacker(atk[2], 'B')
    assert.equal(await s.zoneCount('A', 'hand'), handBefore) // 3 attackers — below threshold
    await s.as('A').declareAttacker(atk[3], 'B')
    await s.as('A').resolveStack() // Light Party trigger resolves

    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 1) // 4th attacker fired the draw
  })
})
