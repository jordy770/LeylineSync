// Group 1 — regression that proves migrations 084/085/086 are behavior-preserving.
// See docs/test-plan-079-086.md for the full checklist.
//
// This file currently encodes the "proving trio" (destroy-spell, activated
// ability, draw) that exercises the whole pipeline end-to-end — the auth.uid()
// claim trick, put_action_on_stack, resolve_top_of_stack, and assertions. Once
// it runs green against local Supabase, expand to the remaining R-cases (the
// `test.todo`s below).
//
// Run: npm test  (requires `supabase start` — see tests/README.md)

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// R1 — destroy via spell: target creature → owner's graveyard, state cleared.
// Exercises apply_creature_effect (086) → put_in_graveyard (084).
test('R1 destroy_creature sends the target to its owner graveyard', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const bear = await s.spawnCreature('B', 'Air Elemental Test')
    await s.as('A').putOnStack('destroy_creature', { target_card_id: bear })
    await s.resolveStack()

    const after = await s.cardState(bear)
    assert.equal(after.zone, 'graveyard')
    assert.equal(after.is_tapped, false)
    assert.equal(after.damage_marked, 0)
    assert.equal(after.controller_player_id, after.owner_id) // controller reset to owner
  })
})

// R8 — activated ability: Prodigal Sorcerer {T}: 1 damage to any target.
// Exercises activate_ability → effective_script (085).
test('R8 activated ability deals 1 damage to a player', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const tim = await s.spawnCreature('A', 'Prodigal Sorcerer Test')
    await s.as('A').activate(tim, 0, { targetPlayerId: s.players.B })
    await s.resolveStack()

    assert.equal(await s.lifeOf('B'), 19)
  })
})

// R11 — draw: the caster draws N from the top of their library.
test('R11 draw_cards moves cards library → hand for the caster', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    // Stock A's library so there is something to draw.
    await s.spawn('A', 'Air Elemental Test', 'library')
    await s.spawn('A', 'Deathtouch Viper Test', 'library')
    await s.spawn('A', 'Silhana Ledgewalker Test', 'library')

    const handBefore = await s.zoneCount('A', 'hand')
    await s.as('A').putOnStack('draw_cards', { amount: 2 })
    await s.resolveStack()

    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 2)
    assert.equal(await s.zoneCount('A', 'library'), 1)
  })
})

// R2 — lethal combat damage: two 4/4 fliers trade; both die in one pass.
// Exercises move_lethal_damaged_creatures_to_graveyard (snapshot+loop, 084).
test('R2 lethal combat damage moves both creatures to graveyard', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const attacker = await s.spawnCreature('A', 'Air Elemental Test') // 4/4 flying
    const blocker = await s.spawnCreature('B', 'Air Elemental Test') // 4/4 flying

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(attacker, 'B')

    await s.setTurn({ phase: 'combat', step: 'declare_blockers', active: 'A', priority: 'B' })
    await s.as('B').declareBlocker(blocker, attacker)

    await s.setTurn({ phase: 'combat', step: 'combat_damage', active: 'A', priority: 'A' })
    await s.as('A').resolveCombat()

    assert.equal(await s.zoneOf(attacker), 'graveyard')
    assert.equal(await s.zoneOf(blocker), 'graveyard')
  })
})

// R3 — dies trigger still fires after destroy. A controls Parting Gift (dies ->
// gain 2); B destroys it. Destroy resolves, the dies trigger enqueues, resolve
// it, A gains 2. Confirms the dies trigger survives the put_in_graveyard route.
test('R3 dies trigger fires after a destroy', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const gift = await s.spawnCreature('A', 'Parting Gift Test')
    const lifeBefore = await s.lifeOf('A')

    await s.as('A').putOnStack('destroy_creature', { target_card_id: gift })
    await s.resolveStack() // creature dies -> dies trigger enqueued
    await s.resolveStack() // dies trigger (gain 2 life) resolves

    assert.equal(await s.zoneOf(gift), 'graveyard')
    assert.equal(await s.lifeOf('A'), lifeBefore + 2)
  })
})

// R4 — bounce returns the target to its owner's hand; no dies trigger.
test('R4 bounce_creature returns the target to owner hand', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const bear = await s.spawnCreature('B', 'Air Elemental Test')
    await s.as('A').putOnStack('bounce_creature', { target_card_id: bear })
    await s.resolveStack()

    const after = await s.cardState(bear)
    assert.equal(after.zone, 'hand')
    assert.equal(after.controller_player_id, after.owner_id)
  })
})

// R5 — tap / untap flip is_tapped.
test('R5 tap_creature then untap_creature flips is_tapped', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const bear = await s.spawnCreature('B', 'Air Elemental Test')

    await s.as('A').putOnStack('tap_creature', { target_card_id: bear })
    await s.resolveStack()
    assert.equal((await s.cardState(bear)).is_tapped, true)

    await s.as('A').putOnStack('untap_creature', { target_card_id: bear })
    await s.resolveStack()
    assert.equal((await s.cardState(bear)).is_tapped, false)
  })
})

// R6 — add_counters puts a +1/+1 counter on the target.
test('R6 add_counters_creature adds a +1/+1 counter', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const bear = await s.spawnCreature('B', 'Air Elemental Test')
    await s.as('A').putOnStack('add_counters_creature', { target_card_id: bear, amount: 1 })
    await s.resolveStack()

    assert.equal((await s.cardState(bear)).plus_one_counters, 1)
  })
})

// R7 — pump applies P/T (until end of turn). Air Elemental 4/4 + 3/3 -> 7/7.
test('R7 pump_creature raises effective P/T', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const bear = await s.spawnCreature('A', 'Air Elemental Test') // 4/4
    await s.as('A').putOnStack('pump_creature', { target_card_id: bear, power: 3, toughness: 3 })
    await s.resolveStack()

    assert.equal(await s.effectivePower(bear), 7)
    assert.equal(await s.effectiveToughness(bear), 7)
  })
})

// R9 — a static keyword registers as a continuous effect and reads back true.
test('R9 flying keyword applies to a creature on the battlefield', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const flyer = await s.spawnCreature('A', 'Air Elemental Test')
    const viper = await s.spawnCreature('B', 'Deathtouch Viper Test')
    await s.rebuild()

    assert.equal(await s.continuousEffectCount(flyer, 'flying'), 1)
    assert.equal(await s.continuousEffectCount(viper, 'deathtouch'), 1)
  })
})

// R10 — a non-keyword continuous effect (Exploration: additional_land_plays)
// registers from the card script.
test('R10 scripted continuous effect registers (Exploration)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const exploration = await s.spawn('A', 'Exploration Test', 'battlefield')
    await s.rebuild()

    assert.equal(await s.continuousEffectCount(exploration, 'additional_land_plays'), 1)
  })
})

// R12 — counter_spell cancels its target stack item.
test('R12 counter_spell cancels the targeted stack item', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    // A puts a draw on the stack; B counters it.
    const target = await s.as('A').putOnStack('draw_cards', { amount: 1 })
    const counterSource = await s.spawn('B', 'Doom Blade Test', 'hand')

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'B' })
    await s.as('B').putOnStack(
      'counter_spell',
      { target_stack_item_id: target.id },
      counterSource,
    )
    await s.resolveStack() // resolves the counter (top), cancelling the draw

    assert.equal(await s.stackStatus(target.id), 'cancelled')
  })
})
