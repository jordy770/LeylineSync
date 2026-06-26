// Myriad (mig 355). "Whenever this attacks, for each opponent other than the
// defending player, create a tapped token copy attacking that opponent. Exile the
// tokens at end of combat." A multiplayer mechanic (no-op in 1v1), so tested with
// 3 players: A's attacker hits B, myriad copies attack C. "you may" is approximated
// as always creating the copies.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function tokenCopies(s: Scenario) {
  const r = await s.client.query<{ id: string }>(
    `select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.zone = 'battlefield' and gc.is_token = true and c.name = 'Master Myriad Test'`,
    [s.sessionId])
  return r.rows
}

// MY1 — attacking one opponent makes a tapped, attacking copy for the other.
test('MY1 myriad makes a tapped attacking copy per other opponent', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 3) // A, B, C
    const master = await s.spawnCreature('A', 'Master Myriad Test')

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(master, 'B') // attacks B; myriad copies attack C
    while (await s.topStackItem()) await s.as('A').resolveStack()

    const toks = await tokenCopies(s)
    assert.equal(toks.length, 1, 'one copy for the other opponent (C)')
    assert.equal((await s.cardState(toks[0].id)).is_tapped, true, 'the copy is tapped')
    const asg = await s.client.query<{ defending_player_id: string }>(
      `select defending_player_id from public.game_combat_assignments where session_id = $1 and attacker_card_id = $2`,
      [s.sessionId, toks[0].id])
    assert.equal(asg.rows[0]?.defending_player_id, s.playerId('C'), 'the copy is attacking C')
  })
})

// MY2 — the copies are exiled at end of combat.
test('MY2 myriad tokens leave at end of combat', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 3)
    const master = await s.spawnCreature('A', 'Master Myriad Test')

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(master, 'B')
    while (await s.topStackItem()) await s.as('A').resolveStack()
    assert.equal((await tokenCopies(s)).length, 1)

    await s.setTurn({ phase: 'combat', step: 'end_of_combat', active: 'A', priority: 'A' })
    await s.as('A').advanceStep() // leaving end_of_combat removes the tokens

    assert.equal((await tokenCopies(s)).length, 0, 'myriad tokens exiled at end of combat')
  })
})
