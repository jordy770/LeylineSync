// Return-on-death (mig 345). Feign Death / Not Dead After All / Supernatural
// Stamina grant a target creature a "when this dies, return it to the battlefield
// tapped (+counter)" ability. Built on grant_dies_effect (mig 344): the spell now
// targets a creature (trigger_effect_target_type), and a new
// return_self_to_battlefield effect re-fields the source from its graveyard. The
// grant is consumed on death so it fires exactly once.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// RD1 — Feign Death: the granted creature returns tapped with a +1/+1 counter.
test('RD1 a creature granted Feign Death returns tapped with a counter', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bear = await s.spawnCreature('A', 'Vampire Bear Test') // 2/2

    await s.as('A').castSpellEffect(
      [{ type: 'grant_dies_effect', target_type: 'creature', effects: [{ type: 'return_self_to_battlefield', tapped: true, plus_one_counters: 1 }] }],
      null, null, bear)
    await s.as('A').resolveStack() // grant applied to the bear

    await s.as('A').putInGraveyard(bear) // it dies → granted trigger fires
    while (await s.topStackItem()) await s.as('A').resolveStack()

    const st = await s.cardState(bear)
    assert.equal(st.zone, 'battlefield', 'returned to the battlefield')
    assert.equal(st.is_tapped, true, 'returned tapped')
    assert.equal(st.plus_one_counters, 1, 'returned with a +1/+1 counter')
  })
})

// RD2 — the grant is one-shot: dying a second time does NOT return it again.
test('RD2 the granted return fires only once', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bear = await s.spawnCreature('A', 'Vampire Bear Test')

    await s.as('A').castSpellEffect(
      [{ type: 'grant_dies_effect', target_type: 'creature', effects: [{ type: 'return_self_to_battlefield', tapped: true }] }],
      null, null, bear)
    await s.as('A').resolveStack()

    await s.as('A').putInGraveyard(bear) // first death → returns
    while (await s.topStackItem()) await s.as('A').resolveStack()
    assert.equal((await s.cardState(bear)).zone, 'battlefield')

    await s.as('A').putInGraveyard(bear) // second death → stays dead
    while (await s.topStackItem()) await s.as('A').resolveStack()
    assert.equal((await s.cardState(bear)).zone, 'graveyard', 'did not return a second time')
  })
})
