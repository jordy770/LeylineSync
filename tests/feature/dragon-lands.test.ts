// mig 237 — three Dragon-deck lands:
//   • Path of Ancestry — enters tapped; taps for any colour (colour-identity
//     restriction + scry rider approximated/deferred).
//   • Temple of the Dragon Queen — enters tapped UNLESS you control a Dragon
//     (or revealed one); taps for any colour.
//   • Haven of the Spirit Dragon — taps for {C} or any; {2},{T},Sacrifice:
//     return a Dragon from your graveyard to hand.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// LB1 — Path of Ancestry enters tapped and taps for a chosen colour.
test('LB1 Path of Ancestry enters tapped, taps for any colour', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const inHand = await s.spawn('A', 'Path of Ancestry Test', 'hand')
    await s.as('A').castPermanent(inHand)
    assert.equal((await s.cardState(inHand)).is_tapped, true)

    const onField = await s.spawn('A', 'Path of Ancestry Test', 'battlefield')
    const pool = await s.as('A').activateMana(onField, 0, null, 'G')
    assert.equal(pool.G, 1)
  })
})

// LB2 — Temple enters tapped with no Dragon, untapped while you control one.
test('LB2 Temple of the Dragon Queen untaps when you control a Dragon', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const noDragon = await s.spawn('A', 'Temple of the Dragon Queen Test', 'hand')
    await s.as('A').castPermanent(noDragon)
    assert.equal((await s.cardState(noDragon)).is_tapped, true)

    await s.spawnCreature('A', 'Dragon Token')
    // A second land play in the same turn — reset the per-turn land counter.
    await s.client.query(
      `update public.game_turn_state set lands_played_this_turn = 0 where session_id = $1`, [s.sessionId])
    const withDragon = await s.spawn('A', 'Temple of the Dragon Queen Test', 'hand')
    await s.as('A').castPermanent(withDragon)
    assert.equal((await s.cardState(withDragon)).is_tapped, false)
  })
})

// LB3 — Haven taps for {C} and its sacrifice ability returns a Dragon from the graveyard.
test('LB3 Haven of the Spirit Dragon ramps and recurs a Dragon', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const mana = await s.spawn('A', 'Haven of the Spirit Dragon Test', 'battlefield')
    assert.equal((await s.as('A').activateMana(mana, 0)).C, 1) // {C}

    const haven = await s.spawn('A', 'Haven of the Spirit Dragon Test', 'battlefield')
    const dragon = await s.spawn('A', 'Rapacious Dragon Test', 'graveyard')
    await s.setMana('A', { C: 2 })
    await s.as('A').activate(haven, 2) // {2},{T},Sacrifice: return a Dragon
    await s.as('A').resolveStack() // parks the return decision
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { chosen: [dragon] })

    assert.equal((await s.cardState(dragon)).zone, 'hand')
    assert.equal((await s.cardState(haven)).zone, 'graveyard') // sacrificed
  })
})
