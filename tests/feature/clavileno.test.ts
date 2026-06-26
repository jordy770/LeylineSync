// Clavileño, First of the Blessed (mig 344). "Whenever you attack, target
// attacking Vampire that isn't a Demon ... gains 'When this creature dies, draw a
// card and create a tapped 4/3 white and black Vampire Demon creature token with
// flying.'" Implemented via a new grant_dies_effect action (stores a
// granted_dies_effect continuous effect on the creature) + a put_in_graveyard
// hook that fires the stored effects on death. APPROXIMATION: the "becomes a
// Demon in addition to its other types" type-change is NOT modelled (no engine
// type-addition); the death payoff — the card's core — is.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function resolveAll(s: Scenario) {
  while (await s.topStackItem()) await s.as('A').resolveStack()
}

// CL1 — an attacking Vampire gains the dies-trigger; when it dies it draws a card
// and makes a tapped Vampire Demon token.
test('CL1 granted dies-trigger draws and makes a token on death', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawnCreature('A', 'Clavileno Test')
    const vamp = await s.spawnCreature('A', 'Vampire Bear Test') // attacking Vampire
    await s.spawn('A', 'Air Elemental Test', 'library') // for the death draw

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(vamp, 'B')
    await resolveAll(s) // the attack trigger grants the dies-effect

    const handBefore = await s.zoneCount('A', 'hand')
    const tokensBefore = await s.zoneCount('A', 'battlefield')

    await s.as("A").putInGraveyard(vamp) // it dies
    await resolveAll(s)

    assert.equal(await s.zoneOf(vamp), 'graveyard')
    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 1, 'drew a card on death')
    // battlefield count: -1 (vamp left) +1 (token) = net same; assert the token exists.
    const tok = await s.client.query<{ n: string }>(
      `select count(*)::int as n from public.game_cards gc join public.cards c on c.id = gc.card_id
       where gc.session_id = $1 and gc.zone = 'battlefield' and c.name = 'Vampire Demon Token'
         and gc.is_tapped = true and coalesce(gc.controller_player_id, gc.owner_id) = $2`,
      [s.sessionId, s.playerId('A')])
    assert.equal(Number(tok.rows[0].n), 1, 'a tapped Vampire Demon token entered')
    void tokensBefore
  })
})

// CL2 — a non-Vampire attacker is not granted the dies-trigger.
test('CL2 a non-Vampire attacker gains nothing', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawnCreature('A', 'Clavileno Test')
    const zombie = await s.spawnCreature('A', 'Grave Shambler Test') // not a Vampire
    await s.spawn('A', 'Air Elemental Test', 'library')

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(zombie, 'B')
    await resolveAll(s)

    const handBefore = await s.zoneCount('A', 'hand')
    await s.as("A").putInGraveyard(zombie)
    await resolveAll(s)

    assert.equal(await s.zoneCount('A', 'hand'), handBefore, 'no death draw')
    const tok = await s.client.query<{ n: string }>(
      `select count(*)::int as n from public.game_cards gc join public.cards c on c.id = gc.card_id
       where gc.session_id = $1 and gc.zone = 'battlefield' and c.name = 'Vampire Demon Token'`,
      [s.sessionId])
    assert.equal(Number(tok.rows[0].n), 0, 'no token made')
  })
})
