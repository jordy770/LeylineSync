// Delina, Wild Mage (mig 360). "Whenever Delina attacks, choose target creature you
// control, then roll a d20. 1-14: create a tapped and attacking token copy (exile at
// end of combat). 15-20: create one of those, you may roll again." Modelled as a
// d20 loop creating tapped attacking copies of the target. The d20 is seeded for a
// deterministic count. "Not legendary" is not modelled.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// DL1 — a roll under 15 makes exactly one tapped attacking copy of the chosen creature.
test('DL1 a low roll makes one tapped attacking copy', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const delina = await s.spawnCreature('A', 'Delina Test')
    const bear = await s.spawnCreature('A', 'Vampire Bear Test')

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(delina, 'B') // Delina's attack trigger wants a target
    const trig = await s.topStackItem()
    assert.equal(trig?.action_type, 'triggered_ability')
    await s.as('A').chooseTriggerTarget(trig!.id, bear) // copy the bear

    // Seed so the first d20 is under 15 (roll 6) → one copy, no roll-again.
    await s.client.query('select setseed(-0.1)')
    while (await s.topStackItem()) await s.as('A').resolveStack()

    const toks = await s.client.query<{ id: string }>(
      `select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
       where gc.session_id = $1 and gc.zone = 'battlefield' and gc.is_token = true and c.name = 'Vampire Bear Test'`,
      [s.sessionId])
    assert.equal(toks.rows.length, 1, 'one copy for a sub-15 roll')
    assert.equal((await s.cardState(toks.rows[0].id)).is_tapped, true, 'the copy is tapped')
    const asg = await s.client.query<{ defending_player_id: string }>(
      `select defending_player_id from public.game_combat_assignments where session_id = $1 and attacker_card_id = $2`,
      [s.sessionId, toks.rows[0].id])
    assert.equal(asg.rows[0]?.defending_player_id, s.playerId('B'), 'attacking the defending player')
  })
})
