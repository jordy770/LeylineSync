// Commander-identity mana (mig 151) — "Add one mana of any color in your commander's
// color identity" (Command Tower, Arcane Signet). add_mana_from_card gains a
// p_commander_identity guard: the produced colour must be in the commander's identity.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// CMM1 — a mono-red commander → a commander-identity source produces R.
test('CMM1 produces a colour in the commander identity', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 2, { format: 'commander' })
    await s.spawnCommander('A', 'Goblin Raider Test', 'command') // {R} → red
    const src = await s.spawn('A', 'Bloodforged Blade Test', 'battlefield') // an artifact source

    const pool = await s.as('A').addManaFromCard(src, 'R', { commanderIdentity: true, tap: true })
    assert.equal(pool.R, 1)
  })
})

// CMM2 — without the guard, mana is client-trusted (unchanged behaviour).
test('CMM2 the guard is opt-in (off = any colour)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 2, { format: 'commander' })
    await s.spawnCommander('A', 'Goblin Raider Test', 'command') // red
    const src = await s.spawn('A', 'Bloodforged Blade Test', 'battlefield')

    const pool = await s.as('A').addManaFromCard(src, 'U', { commanderIdentity: false })
    assert.equal(pool.U, 1) // blue allowed when the guard is off
  })
})

// CMM3 — with the guard, an off-identity colour is rejected. (Kept last — the
// expected rejection aborts the test transaction.)
test('CMM3 rejects a colour outside the commander identity', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 2, { format: 'commander' })
    await s.spawnCommander('A', 'Goblin Raider Test', 'command') // red only
    const src = await s.spawn('A', 'Bloodforged Blade Test', 'battlefield')

    await assert.rejects(
      () => s.as('A').addManaFromCard(src, 'U', { commanderIdentity: true, tap: true }),
      /not in your commander/i,
    )
  })
})
