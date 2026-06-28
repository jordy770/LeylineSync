// Cast-watcher self-trigger (mig 325) — a "whenever you cast a creature spell"
// ability is only active while its source is on the battlefield. Casting the
// source itself (it's on the stack, not the battlefield) must NOT trigger it
// (Bygone Bishop / Eshki casting themselves). Other creature spells cast while it
// IS on the battlefield still trigger it.
//
// Eshki Test: "Whenever you cast a creature spell, put a +1/+1 counter on Eshki."

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// CW1 — casting Eshki itself does NOT trigger its own creature-cast watcher.
test('CW1 a creature-cast watcher does not fire for casting its own source', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const eshki = await s.spawn('A', 'Eshki Test', 'hand') // Creature {1}{G}{U}

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { G: 1, U: 1, C: 1 })

    await s.as('A').castPermanent(eshki)
    await s.as('A').resolveStack()

    const st = await s.cardState(eshki)
    assert.equal(st.zone, 'battlefield', 'Eshki resolved to the battlefield')
    assert.equal(st.plus_one_counters, 0, 'Eshki did not put a counter on itself for its own cast')
  })
})

// CW2 — once Eshki is on the battlefield, casting ANOTHER creature spell triggers it.
test('CW2 the watcher still fires for another creature spell cast while it is fielded', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const eshki = await s.spawnCreature('A', 'Eshki Test') // already on the battlefield (2/2)
    const other = await s.spawn('A', 'Red Wall Test', 'hand') // Creature {R}

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { R: 1 })

    await s.as('A').castPermanent(other)
    await s.as('A').resolveStack()

    const st = await s.cardState(eshki)
    assert.equal(st.plus_one_counters, 1, 'Eshki got a +1/+1 counter from the other creature cast')
  })
})
