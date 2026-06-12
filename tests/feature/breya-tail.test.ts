// mig 270 — Breya tail: any-graveyard reanimation with decider control
// and a haste rider (Beacon of Unrest / Grave Upheaval).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// BT1 — Grave Upheaval steals from the OPPONENT's graveyard, with haste.
test('BT1 any-graveyard reanimation under the decider with haste', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const corpse = await s.spawn('B', 'Air Elemental Test', 'graveyard') // THEIR graveyard

    await s.as('A').castSpellEffect([
      { type: 'return_from_graveyard', count: 1, to: 'battlefield',
        from: 'all_graveyards', control: 'decider', haste: true,
        filter: { type_line: 'creature' } }])
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'return_from_graveyard')
    const ids = (d!.options as Array<{ game_card_id: string }>).map((o) => o.game_card_id)
    assert.ok(ids.includes(corpse)) // an opposing graveyard card is offered
    await s.as('A').submitDecision(d!.id, { chosen: [corpse] })

    const row = await s.client.query<{ zone: string; controller_player_id: string }>(
      'select zone, controller_player_id from public.game_cards where id = $1', [corpse])
    assert.equal(row.rows[0]!.zone, 'battlefield')
    assert.equal(row.rows[0]!.controller_player_id, s.players.A) // decider controls it
    const haste = await s.client.query(
      `select 1 from public.game_continuous_effects
       where session_id = $1 and affected_card_id = $2 and effect_type = 'haste'`,
      [s.sessionId, corpse])
    assert.ok(haste.rows.length >= 1)
  })
})
