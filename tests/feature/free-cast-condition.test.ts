// Conditional free cast (mig 429, Deadly Rollick) — "If you control a
// commander, you may cast this spell without paying its mana cost."
// put_action_on_stack(p_free_cast => true) skips the mana payment ONLY when the
// source card's script carries a `free_cast_condition` and the condition holds
// (controls_commander: a battlefield commander under the caster's control).
// Everything else — targeting, protection/hexproof, timing — is unchanged.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// FC1 — with a commander on the battlefield the cast is free: no mana needed.
test('FC1 free cast works with zero mana while you control a commander', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCommander('A', 'Reaper Commander Test', 'battlefield')
    const spell = await s.spawn('A', 'Free Rollick Test', 'hand')
    const foeCreature = await s.spawn('B', 'Air Elemental Test', 'battlefield')

    await s.as('A').putOnStack('exile_creature', { target_card_id: foeCreature }, spell, true)
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(foeCreature), 'exile')
    assert.equal(await s.zoneOf(spell), 'graveyard')
  })
})

// FC2 — no commander under your control: the free cast is refused.
test('FC2 free cast without a commander is rejected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    // Commander still in the command zone does NOT satisfy "you control a commander".
    await s.spawnCommander('A', 'Reaper Commander Test', 'command')
    const spell = await s.spawn('A', 'Free Rollick Test', 'hand')
    const foeCreature = await s.spawn('B', 'Air Elemental Test', 'battlefield')
    await assert.rejects(
      () => s.as('A').putOnStack('exile_creature', { target_card_id: foeCreature }, spell, true),
      /commander/i,
    )
  })
})

// FC3 — a card without a free_cast_condition can never be cast free.
test('FC3 free cast on a card without the script condition is rejected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCommander('A', 'Reaper Commander Test', 'battlefield')
    const spell = await s.spawn('A', 'Murder Test', 'hand')
    const foeCreature = await s.spawn('B', 'Air Elemental Test', 'battlefield')
    await assert.rejects(
      () => s.as('A').putOnStack('destroy_creature', { target_card_id: foeCreature }, spell, true),
      /free/i,
    )
  })
})

// FC4 — the normal (paid) cast of the same card still charges mana.
test('FC4 paid cast of the card still requires mana', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCommander('A', 'Reaper Commander Test', 'battlefield')
    const spell = await s.spawn('A', 'Free Rollick Test', 'hand')
    const foeCreature = await s.spawn('B', 'Air Elemental Test', 'battlefield')
    await assert.rejects(
      () => s.as('A').putOnStack('exile_creature', { target_card_id: foeCreature }, spell),
      /not enough .*mana/i,
    )
  })
})
