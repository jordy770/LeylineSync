// Blade of Selves (mig 357). "Equipped creature has myriad." Built on the new
// granted_ability mechanism: a continuous effect (affected:'equipped') whose
// payload carries a triggered ability (attacks → myriad); effective_script merges
// it onto the equipped creature so fire_card_triggers sees the myriad trigger.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// BS1 — an equipped creature gains myriad: attacking B makes a copy attacking C.
test('BS1 the equipped creature has myriad', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 3) // A, B, C
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const blade = await s.spawn('A', 'Blade Test', 'battlefield')
    const bear = await s.spawnCreature('A', 'Vampire Bear Test')
    await s.setMana('A', { C: 4 })
    await s.as('A').equip(blade, bear, { generic: { C: 4 } })

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(bear, 'B') // myriad copies attack C
    while (await s.topStackItem()) await s.as('A').resolveStack()

    const toks = await s.client.query<{ id: string }>(
      `select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
       where gc.session_id = $1 and gc.zone = 'battlefield' and gc.is_token = true and c.name = 'Vampire Bear Test'`,
      [s.sessionId])
    assert.equal(toks.rows.length, 1, 'myriad made a copy for the other opponent')
    const asg = await s.client.query<{ defending_player_id: string }>(
      `select defending_player_id from public.game_combat_assignments where session_id = $1 and attacker_card_id = $2`,
      [s.sessionId, toks.rows[0].id])
    assert.equal(asg.rows[0]?.defending_player_id, s.playerId('C'), 'the copy attacks C')
  })
})
