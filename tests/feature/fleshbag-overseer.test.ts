// Free compositions for the Gisa deck's last two creatures — no engine change,
// just proving the path combinations:
//   Fleshbag Marauder — "When this creature enters, each player sacrifices a
//     creature of their choice" (each_player edict from a TRIGGER; mig 198
//     proved the spell path only).
//   Overseer of the Damned — ETB targeted destroy + "whenever a NONTOKEN
//     creature an opponent controls dies, create a TAPPED 2/2 Zombie token"
//     (nontoken+opponent watcher, mig 181, with a tapped token).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// FB1 — the ETB edict chains a sacrifice decision per player, in seat order.
test('FB1 Fleshbag Marauder: each player sacrifices', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const theirs = await s.spawnCreature('B', 'Goblin Raider Test')
    const fleshbag = await s.spawnCreature('A', 'Fleshbag Marauder Test')

    await s.as('A').resolveStack() // ETB → first sacrifice decision (seat A)
    let d = await s.pendingDecision()
    assert.equal(d?.decision_type, 'sacrifice')
    assert.equal(d?.deciding_player_id, s.playerId('A'))
    await s.as('A').submitDecision(d!.id, { chosen: [fleshbag] }) // sac itself

    d = await s.pendingDecision() // then seat B
    assert.equal(d?.deciding_player_id, s.playerId('B'))
    await s.as('B').submitDecision(d!.id, { chosen: [theirs] })

    assert.equal(await s.zoneOf(fleshbag), 'graveyard')
    assert.equal(await s.zoneOf(theirs), 'graveyard')
  })
})

async function zombieTokens(s: Scenario, seat: 'A' | 'B'): Promise<{ id: string; tapped: boolean }[]> {
  const r = await s.client.query<{ id: string; is_tapped: boolean }>(
    `select gc.id, gc.is_tapped from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.controller_player_id = $2 and gc.zone = 'battlefield'
       and c.name = 'Zombie Token'`,
    [s.sessionId, s.players[seat]],
  )
  return r.rows.map((row) => ({ id: row.id, tapped: row.is_tapped }))
}

// OD1 — ETB destroy kills an opponent's nontoken creature, which ALSO fires the
// Overseer's own death watcher: a tapped Zombie token for its controller.
test('OD1 Overseer: ETB removal feeds its own token watcher', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const victim = await s.spawnCreature('B', 'Goblin Raider Test')
    await s.spawnCreature('A', 'Overseer of the Damned Test')

    const item = await s.topStackItem() // the targeted ETB trigger
    await s.as('A').chooseTriggerTarget(item!.id, victim)
    await s.as('A').resolveStack() // destroy resolves; the death watcher enqueues
    await s.as('A').resolveStack() // the create-token trigger resolves

    assert.equal(await s.zoneOf(victim), 'graveyard')
    const tokens = await zombieTokens(s, 'A')
    assert.equal(tokens.length, 1)
    assert.equal(tokens[0]!.tapped, true) // enters TAPPED
  })
})

// OD2 — the watcher filters: your own creature dying adds no token.
test('OD2 Overseer ignores your own deaths', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const victim = await s.spawnCreature('B', 'Goblin Raider Test')
    await s.spawnCreature('A', 'Overseer of the Damned Test')
    const item = await s.topStackItem()
    await s.as('A').chooseTriggerTarget(item!.id, victim) // ETB consumes the opponent's creature
    await s.as('A').resolveStack()
    await s.as('A').resolveStack()
    assert.equal((await zombieTokens(s, 'A')).length, 1) // baseline: one token

    // Now A's OWN creature dies — the opponent-only watcher must not fire.
    const mine = await s.spawnCreature('A', 'Goblin Raider Test')
    await s.as('A').putOnStack('destroy_creature', { target_card_id: mine, target_controller: 'any' })
    await s.as('A').resolveStack()

    assert.equal((await zombieTokens(s, 'A')).length, 1) // unchanged
  })
})
