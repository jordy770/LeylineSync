// Phase 3, slice 1 — general multi-target removal (mig 112): the
// `multi_creature_effect` action type applies one removal kind (destroy / exile /
// bounce / tap / untap) to up to N target creatures. Cast directly via
// put_action_on_stack (the same path the client wrapper uses), so no fixture or
// client UI is needed to exercise the engine.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// MT1 — destroy two target creatures: both go to the graveyard, stack resolves.
test('MT1 multi destroy sends every chosen creature to the graveyard', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const a = await s.spawnCreature('B', 'Air Elemental Test')
    const b = await s.spawnCreature('B', 'Deathtouch Viper Test')

    const item = await s
      .as('A')
      .putOnStack('multi_creature_effect', { kind: 'destroy', target_card_ids: [a, b], target_controller: 'any' })
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(a), 'graveyard')
    assert.equal(await s.zoneOf(b), 'graveyard')
    assert.equal(await s.stackStatus(item.id), 'resolved')
  })
})

// MT2 — tap is a non-destructive kind: both creatures end tapped.
test('MT2 multi tap taps every chosen creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const a = await s.spawnCreature('B', 'Air Elemental Test')
    const b = await s.spawnCreature('B', 'Deathtouch Viper Test')

    await s.as('A').putOnStack('multi_creature_effect', { kind: 'tap', target_card_ids: [a, b] })
    await s.as('A').resolveStack()

    assert.equal((await s.cardState(a)).is_tapped, true)
    assert.equal((await s.cardState(b)).is_tapped, true)
  })
})

// MT3 — bounce to hand of two targets the caster controls (target_controller 'you').
test('MT3 multi bounce returns every chosen creature to its owner hand', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const a = await s.spawnCreature('A', 'Air Elemental Test')
    const b = await s.spawnCreature('A', 'Deathtouch Viper Test')

    await s
      .as('A')
      .putOnStack('multi_creature_effect', { kind: 'bounce', target_card_ids: [a, b], target_controller: 'you' })
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(a), 'hand')
    assert.equal(await s.zoneOf(b), 'hand')
  })
})

// MT4 — partial fizzle: a target that has left the battlefield before resolution is
// skipped; the spell still resolves for the remaining legal target.
test('MT4 multi destroy resolves for the legal targets when one has left', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const a = await s.spawnCreature('B', 'Air Elemental Test')
    const b = await s.spawnCreature('B', 'Deathtouch Viper Test')

    const item = await s
      .as('A')
      .putOnStack('multi_creature_effect', { kind: 'destroy', target_card_ids: [a, b], target_controller: 'any' })
    // a leaves the battlefield after targets are locked, before resolution.
    await client.query(`update public.game_cards set zone = 'exile' where id = $1`, [a])

    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(b), 'graveyard') // the still-legal target is destroyed
    assert.equal(await s.zoneOf(a), 'exile') // untouched
    assert.equal(await s.stackStatus(item.id), 'resolved')
  })
})

// MT5 — controller restriction is enforced at cast: an illegal target in the set
// rejects the whole cast (your own creature is not a legal 'opponent' target).
// (A raised error poisons the single test tx, so we assert only the rejection.)
test('MT5 multi effect rejects a cast that includes an illegal target', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const opp = await s.spawnCreature('B', 'Air Elemental Test')
    const mine = await s.spawnCreature('A', 'Deathtouch Viper Test') // not an 'opponent' creature

    await assert.rejects(
      () =>
        s
          .as('A')
          .putOnStack('multi_creature_effect', {
            kind: 'destroy',
            target_card_ids: [opp, mine],
            target_controller: 'opponent',
          }),
      /legal creature/,
    )
  })
})

// MT6 — an empty target set is rejected (a multi-target spell needs ≥1 target).
test('MT6 multi effect rejects an empty target set', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    await assert.rejects(
      () => s.as('A').putOnStack('multi_creature_effect', { kind: 'destroy', target_card_ids: [] }),
      /at least one target/,
    )
  })
})
