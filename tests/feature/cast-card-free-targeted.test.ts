// mig 420 — cast_card_free's targeted-spell path: a found instant that needs a
// target parks a 'spell_effect' stack item in the triggered-ability target shape;
// choose_triggered_ability_creature_target (guard relaxed to accept 'spell_effect')
// sets the target; apply_trigger_effects resolves the effect against it.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { asPlayer } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => { await ensureTestCards() })

test('CFT1 free-cast of a targeted instant parks a target on the spell, resolves on it', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const victim = await s.spawnCreature('B', 'Grave Shambler Test')
    const terminate = await s.spawn('A', 'Cascade Terminate Test', 'exile')

    // cast_card_free runs its manual push with no auth.uid() dependency, but wrap
    // it as A for consistency with the authenticated cast path.
    await asPlayer(client, s.playerId('A'), () =>
      client.query('select public.cast_card_free($1, $2, $3)', [s.sessionId, terminate, s.playerId('A')]))

    const item = await s.topStackItem()
    assert.ok(item, 'a spell_effect stack item is parked')
    assert.equal(item!.action_type, 'spell_effect')
    assert.equal(item!.payload.target_required, true)
    // the instant left exile for the graveyard on cast
    assert.equal(await s.zoneOf(terminate), 'graveyard')

    await s.as('A').chooseTriggerTarget(item!.id, victim)
    await s.as('A').resolveStack()
    assert.equal(await s.zoneOf(victim), 'graveyard')
  })
})

test('CFT3 resolving a targeted free-cast before its target is chosen raises (no silent fizzle)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('B', 'Grave Shambler Test')
    const terminate = await s.spawn('A', 'Cascade Terminate Test', 'exile')
    await asPlayer(client, s.playerId('A'), () =>
      client.query('select public.cast_card_free($1, $2, $3)', [s.sessionId, terminate, s.playerId('A')]))
    // handle_spell_effect must refuse to resolve the item until a target is set,
    // rather than fizzling the effect (the source is already in the graveyard).
    await assert.rejects(
      () => s.as('A').resolveStack() as Promise<unknown>,
      /requires a target to be chosen first/i)
  })
})

test('CFT4 no legal target left → resolves (fizzles) instead of soft-locking', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    // No creature anywhere → "destroy target creature" has no legal target.
    const terminate = await s.spawn('A', 'Cascade Terminate Test', 'exile')
    await asPlayer(client, s.playerId('A'), () =>
      client.query('select public.cast_card_free($1, $2, $3)', [s.sessionId, terminate, s.playerId('A')]))
    // Must NOT raise (no legal target to choose) — the spell fizzles and the stack clears.
    await s.as('A').resolveStack()
    assert.equal(await s.pendingCount(), 0)
  })
})

test('CFT2 the target-shape relaxation still rejects a normal (non-free) cast spell_effect', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const victim = await s.spawnCreature('B', 'Grave Shambler Test')
    // A normal cast_spell_effect item carries no target_required flag, so the relaxed
    // chooser guard must still reject it (only free-cast items are choosable this way).
    await s.as('A').castSpellEffect(
      [{ type: 'destroy', target_type: 'creature' }], null, null, victim)
    const item = await s.topStackItem()
    assert.equal(item!.action_type, 'spell_effect')
    await assert.rejects(
      () => s.as('A').chooseTriggerTarget(item!.id, victim) as Promise<unknown>,
      /does not require a trigger target/i)
  })
})
