// Cast-planner round-2 fixes — two spells that were engine-supported in principle
// but uncastable/unresolved from a hand cast:
//   • Dark Ritual      → add_mana spell: resolves via the spell_effect program
//     path (cast_spell_effect → handle_spell_effect → apply_trigger_effects →
//     apply_triggered_ability_effects) to the CASTER's mana pool. No target.
//   • Harmless Offering → permanent_effect kind=gain_control with `to:opponent`:
//     the cast path (mig 362) accepts kind=gain_control + threads `to`. 1v1
//     donates directly to the sole opponent; multiplayer parks a choose_player
//     decision so the caster picks WHICH opponent (mig 363).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// DR1 — Dark Ritual adds {B}{B}{B} to the caster's pool on resolution.
test('DR1 add_mana spell resolves to the caster mana pool', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const before = (await s.manaOf('A')).B ?? 0

    await s.as('A').castSpellEffect([{ type: 'add_mana', color: 'B', amount: 3 }])
    while (await s.topStackItem()) await s.as('A').resolveStack()

    assert.equal((await s.manaOf('A')).B, before + 3, 'caster gained {B}{B}{B}')
  })
})

// HO1 — 1v1: a single opponent needs no choice; the donate applies directly.
test('HO1 gain_control to:opponent donates to the sole opponent (no prompt)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const perm = await s.spawnCreature('A', 'Vampire Bear Test') // A controls it
    assert.equal((await s.cardState(perm)).controller_player_id, s.playerId('A'))

    await s.as('A').putOnStack('permanent_effect', {
      kind: 'gain_control', target_card_id: perm, target_type: 'permanent', to: 'opponent',
    })
    await s.as('A').resolveStack()

    assert.equal(await s.pendingDecision(), null, '1v1 needs no player choice')
    assert.equal(
      (await s.cardState(perm)).controller_player_id, s.playerId('B'),
      'the opponent now controls the donated permanent',
    )
    assert.equal(await s.zoneOf(perm), 'battlefield')
  })
})

// HO2 — multiplayer: the caster CHOOSES which opponent gains the permanent via a
// parked choose_player decision. Pick C (not the lowest-seat default B) to prove
// the choice is real.
test('HO2 donate lets the caster choose the opponent in multiplayer', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 3)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const perm = await s.spawnCreature('A', 'Vampire Bear Test')

    await s.as('A').putOnStack('permanent_effect', {
      kind: 'gain_control', target_card_id: perm, target_type: 'permanent', to: 'opponent',
    })
    await s.as('A').resolveStack() // parks a choose_player decision

    const d = await s.pendingDecision()
    assert.equal(d?.decision_type, 'choose_player')
    assert.equal(d?.deciding_player_id, s.playerId('A'), 'the caster chooses')
    await s.as('A').submitDecision(d!.id, { player_id: s.playerId('C') })

    assert.equal(
      (await s.cardState(perm)).controller_player_id, s.playerId('C'),
      'the chosen opponent (C, not default B) controls the donated permanent',
    )
    assert.equal(await s.zoneOf(perm), 'battlefield')
  })
})
