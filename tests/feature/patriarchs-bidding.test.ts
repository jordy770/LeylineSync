// Patriarch's Bidding (mig 343). "Each player chooses a creature type. Each
// player returns all creature cards of a type chosen this way from their
// graveyard to the battlefield." New who:'each_player' on choose_creature_type
// (a per-player decision queue in seat order) + $chosen injection into
// return_all_from_graveyard, which returns the DECIDING player's own graveyard
// creatures of their chosen type.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

const BIDDING = [{
  type: 'choose_creature_type',
  who: 'each_player',
  effects: [{ type: 'return_all_from_graveyard', creature_type: '$chosen', to: 'battlefield' }],
}]

// PB1 — each player picks their own type and reanimates their own graveyard.
test('PB1 each player returns their chosen type from their own graveyard', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const av1 = await s.spawn('A', 'Vampire Bear Test', 'graveyard') // A: Vampires
    const av2 = await s.spawn('A', 'Vampire Bear Test', 'graveyard')
    const az = await s.spawn('A', 'Grave Shambler Test', 'graveyard') // A: a Zombie (not chosen by A)
    const bz1 = await s.spawn('B', 'Grave Shambler Test', 'graveyard') // B: Zombies
    const bz2 = await s.spawn('B', 'Grave Shambler Test', 'graveyard')

    await s.as('A').castSpellEffect(BIDDING)
    await s.as('A').resolveStack() // parks A's choose_creature_type (first in seat order)

    let d = await s.pendingDecision()
    assert.equal(d?.decision_type, 'choose_creature_type')
    assert.equal(d?.deciding_player_id, s.playerId('A'))
    await s.as('A').submitDecision(d!.id, { type: 'Vampire' }) // A returns Vampires

    d = await s.pendingDecision() // queue advances to B
    assert.equal(d?.deciding_player_id, s.playerId('B'))
    await s.as('B').submitDecision(d!.id, { type: 'Zombie' }) // B returns Zombies

    assert.equal(await s.zoneOf(av1), 'battlefield', "A's Vampire returned")
    assert.equal(await s.zoneOf(av2), 'battlefield')
    assert.equal(await s.zoneOf(az), 'graveyard', "A's Zombie stayed (A chose Vampire)")
    assert.equal(await s.zoneOf(bz1), 'battlefield', "B's Zombie returned")
    assert.equal(await s.zoneOf(bz2), 'battlefield')

    // returned under each card's owner's control
    assert.equal((await s.cardState(av1)).controller_player_id, s.playerId('A'))
    assert.equal((await s.cardState(bz1)).controller_player_id, s.playerId('B'))
  })
})
