// Curse of Disturbance (mig 199) — "Enchant player. Whenever enchanted player is
// attacked, create a 2/2 black Zombie token. Each opponent attacking that player
// does the same." Modeled as an ETB choose_player that registers a 'curse_attacked'
// continuous effect on the chosen player; declare_attacker reacts.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function drainStack(s: Scenario): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const r = await s.client.query<{ n: string }>(
      "select count(*) as n from public.game_stack_items where session_id = $1 and status <> 'resolved'",
      [s.sessionId],
    )
    if (Number(r.rows[0]!.n) === 0) return
    await s.resolveStack()
  }
}

async function zombieTokens(s: Scenario, seat: 'A' | 'B' | 'C'): Promise<number> {
  const r = await s.client.query<{ n: string }>(
    `select count(*) as n from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.controller_player_id = $2 and gc.zone = 'battlefield' and c.name = 'Zombie Token'`,
    [s.sessionId, s.players[seat]],
  )
  return Number(r.rows[0]?.n ?? 0)
}

// CD1 — A's curse enchants B; when C attacks B, A (controller) AND C (attacking
// opponent) each create a Zombie.
test('CD1 attacking the enchanted player makes the controller and attacker a Zombie', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 3)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    await s.spawn('A', 'Curse of Disturbance Test', 'battlefield')
    await s.as('A').resolveStack() // resolve the ETB trigger -> parks choose_player
    const d = await s.pendingDecision()
    assert.equal(d?.decision_type, 'choose_player')
    await s.as('A').submitDecision(d!.id, { player_id: s.playerId('B') }) // enchant B

    const attacker = await s.spawnCreature('C', 'Grave Shambler Test')
    await s.as('A').rebuild()

    // C's turn: C attacks the enchanted player B.
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'C', priority: 'C' })
    await s.as('C').declareAttacker(attacker, 'B')
    await drainStack(s) // resolve the enqueued curse triggers

    assert.equal(await zombieTokens(s, 'A'), 1) // the curse's controller
    assert.equal(await zombieTokens(s, 'C'), 1) // the attacking opponent "does the same"
    assert.equal(await zombieTokens(s, 'B'), 0) // the enchanted player gets nothing
  })
})

// CD2 — attacking a DIFFERENT (un-enchanted) player does not trigger the curse.
test('CD2 attacking a player who is not enchanted does nothing', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 3)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    await s.spawn('A', 'Curse of Disturbance Test', 'battlefield')
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { player_id: s.playerId('B') }) // enchant B

    const attacker = await s.spawnCreature('C', 'Grave Shambler Test')
    await s.as('A').rebuild()

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'C', priority: 'C' })
    await s.as('C').declareAttacker(attacker, 'A') // attacks A, not the enchanted B
    await drainStack(s)

    assert.equal(await zombieTokens(s, 'A'), 0)
    assert.equal(await zombieTokens(s, 'C'), 0)
  })
})
