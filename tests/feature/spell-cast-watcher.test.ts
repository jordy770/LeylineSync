// Spell-cast watcher (mig 234):
//   • Taurean Mauler — "Whenever an opponent casts a spell, you may put a +1/+1
//     counter on this creature." (Changeling is not modelled.)
//   • Encroaching Dragonstorm — ETB ramp (search two basics) + "When a Dragon you
//     control enters, return this enchantment to its owner's hand."

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// SC1 — an opponent's spell grows Taurean Mauler when its controller confirms.
test('SC1 Taurean Mauler grows when an opponent casts a spell', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const mauler = await s.spawnCreature('A', 'Taurean Mauler Test')
    const spell = await s.spawn('B', 'Red Wall Test', 'hand') // {R} creature spell

    // B casts a spell.
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'B', priority: 'B' })
    await s.setMana('B', { R: 1 })
    await s.as('B').castPermanent(spell)

    // The opponent-cast watcher parks A's "may" decision.
    await s.as('B').resolveStack()
    const d = await s.pendingDecision()
    assert.equal(d!.deciding_player_id, s.players.A)
    await s.as('A').submitDecision(d!.id, { confirmed: true })

    assert.equal((await s.cardState(mauler)).plus_one_counters, 1)
  })
})

// SC2 — Encroaching Dragonstorm ramps on ETB, then bounces itself when a Dragon enters.
test('SC2 Encroaching Dragonstorm ramps, then returns when a Dragon enters', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const b1 = await s.spawn('A', 'Wastes Test', 'library')
    const b2 = await s.spawn('A', 'Island Test', 'library')

    const storm = await s.spawn('A', 'Encroaching Dragonstorm Test', 'battlefield') // ETB search
    await s.as('A').resolveStack()
    const dig = await s.pendingDecision()
    await s.as('A').submitDecision(dig!.id, { chosen: [b1, b2] })
    assert.equal((await s.cardState(b1)).zone, 'battlefield')

    // A Dragon enters → the enchantment returns to hand.
    await s.spawnCreature('A', 'Dragon Token')
    await s.as('A').resolveStack()
    assert.equal((await s.cardState(storm)).zone, 'hand')
  })
})
