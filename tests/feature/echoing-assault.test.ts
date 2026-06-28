// Echoing Assault (mig 359). "Whenever you attack a player, choose target nontoken
// creature attacking that player. Create a token that's a 1/1 copy of it, tapped
// and attacking that player; sacrifice it at the next end step." Approximated as a
// creature_attacks watcher (controller:you, nontoken) that copies the triggering
// attacker as a 1/1 tapped attacking the same player (attacking_defender:'$defender').

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// EA1 — attacking with a nontoken creature makes a 1/1 tapped copy attacking the
// same player.
test('EA1 attacking makes a 1/1 tapped copy attacking the defender', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawn('A', 'Echoing Assault Test', 'battlefield')
    const bear = await s.spawnCreature('A', 'Vampire Bear Test') // 2/2

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(bear, 'B')
    while (await s.topStackItem()) await s.as('A').resolveStack()

    const toks = await s.client.query<{ id: string }>(
      `select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
       where gc.session_id = $1 and gc.zone = 'battlefield' and gc.is_token = true and c.name = 'Vampire Bear Test'`,
      [s.sessionId])
    assert.equal(toks.rows.length, 1, 'a copy of the attacker was made')
    assert.equal(await s.effectivePower(toks.rows[0].id), 1, 'the copy is 1/1 (power)')
    assert.equal((await s.cardState(toks.rows[0].id)).is_tapped, true, 'tapped')
    const asg = await s.client.query<{ defending_player_id: string }>(
      `select defending_player_id from public.game_combat_assignments where session_id = $1 and attacker_card_id = $2`,
      [s.sessionId, toks.rows[0].id])
    assert.equal(asg.rows[0]?.defending_player_id, s.playerId('B'), 'attacking the same player (B)')
  })
})
