// Optional ("up to one target …") triggered-ability targets (mig 326). A trigger
// whose targeting effect is `optional` resolves as a no-op when no target is
// chosen — it never raises "Triggered ability requires a target", so it can't
// soft-lock the stack (Obuun's begin-combat animate). A REQUIRED target still
// raises when left unchosen.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// OT1 — an optional target left unchosen resolves cleanly (no raise, no effect).
test('OT1 optional triggered-ability target resolves no-op when not chosen', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const bear = await s.spawnCreature('A', 'Air Elemental Test') // a legal creature target exists
    const pinger = await s.spawn('A', 'Optional Counter ETB Test', 'hand')

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { C: 1 })

    await s.as('A').castPermanent(pinger)
    await s.as('A').resolveStack() // the creature spell resolves → ETB trigger enqueues
    await s.as('A').resolveStack() // OPTIONAL ETB trigger resolves with NO target → must not raise

    // No counter was placed (the optional target was declined), and the game moved on.
    assert.equal((await s.cardState(bear)).plus_one_counters, 0)
  })
})

// OT2 — a required target still raises when left unchosen (regression).
test('OT2 a required triggered-ability target still raises when unchosen', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawnCreature('A', 'Air Elemental Test') // a legal target exists → must be chosen
    const pinger = await s.spawn('A', 'Required Counter ETB Test', 'hand')

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { C: 1 })

    await s.as('A').castPermanent(pinger)
    await s.as('A').resolveStack() // creature spell resolves → required ETB trigger enqueues
    await assert.rejects(() => s.as('A').resolveStack(), /requires a target/)
  })
})
