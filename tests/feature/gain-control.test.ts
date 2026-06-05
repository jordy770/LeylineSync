// Tier-2 effect: gain_control (migration 106) — Threaten / Mind Control on the
// TRIGGER path. The ability's controller takes control of a picked creature;
// duration is permanent or until end of turn. Control is a direct column, so the
// until-EOT case inserts a 'control' continuous effect that the cleanup sweep
// reverts. The fought/controlled creature is chosen through the standard trigger
// target picker (same flow as fight/grant_keyword triggers).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// GC1 — until end of turn: A's ETB takes control of B's creature; control flips to
// A on resolve, then reverts to B (the owner) when the cleanup sweep runs.
test('GC1 gain_control (end_of_turn): control flips to the controller, reverts at cleanup', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const prey = await s.spawnCreature('B', 'Silhana Ledgewalker Test') // 1/1, no ETB trigger
    const brute = await s.spawnCreature('A', 'Usurp Brute Test') // ETB gain control until EOT

    const trigger = await s.topStackItem()
    assert.equal(trigger?.action_type, 'triggered_ability')

    await s.as('A').chooseTriggerTarget(trigger!.id, prey)
    await s.resolveStack()

    const bruteState = await s.cardState(brute)
    let preyState = await s.cardState(prey)
    assert.equal(preyState.controller_player_id, bruteState.controller_player_id) // A controls it now
    assert.notEqual(preyState.controller_player_id, preyState.owner_id) // taken from B

    // End-of-turn cleanup: control returns to the owner.
    await s.as('A').expireEffects('ending', 'cleanup')

    preyState = await s.cardState(prey)
    assert.equal(preyState.controller_player_id, preyState.owner_id) // reverted to B
  })
})

// GC2 — permanent: control flips to A and does NOT revert at cleanup (no 'control'
// continuous effect is created for a permanent control change).
test('GC2 gain_control (permanent): control does not revert at cleanup', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const prey = await s.spawnCreature('B', 'Silhana Ledgewalker Test')
    const beast = await s.spawnCreature('A', 'Dominate Beast Test') // ETB gain control permanently

    const trigger = await s.topStackItem()
    assert.equal(trigger?.action_type, 'triggered_ability')

    await s.as('A').chooseTriggerTarget(trigger!.id, prey)
    await s.resolveStack()

    const beastState = await s.cardState(beast)
    let preyState = await s.cardState(prey)
    assert.equal(preyState.controller_player_id, beastState.controller_player_id) // A controls it

    await s.as('A').expireEffects('ending', 'cleanup')

    preyState = await s.cardState(prey)
    assert.equal(preyState.controller_player_id, beastState.controller_player_id) // still A
    assert.notEqual(preyState.controller_player_id, preyState.owner_id)
  })
})

// GC3 — controller restriction ("you don't control"): can't pick your own creature
// as the target (target_controller=opponent). A legal target exists so it won't
// fizzle; the illegal pick is rejected.
test('GC3 gain_control trigger rejects targeting your own creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const alsoMine = await s.spawnCreature('A', 'Welcome Drain Test') // illegal target (yours)
    await s.spawnCreature('B', 'Silhana Ledgewalker Test') // a legal target exists
    const brute = await s.spawnCreature('A', 'Usurp Brute Test')

    const trigger = await s.topStackItem()
    assert.equal(trigger?.action_type, 'triggered_ability')

    await assert.rejects(() => s.as('A').chooseTriggerTarget(trigger!.id, alsoMine))
    void brute
  })
})

// GC4 — SPELL path (Act of Treason): cast gain_control_creature with the threaten
// extras (untap + haste, until end of turn). The caster takes control, the
// creature is untapped and gains haste; at cleanup control reverts and the
// until-EOT effects lapse.
test('GC4 gain_control_creature spell: untap + haste, control reverts at cleanup', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const prey = await s.spawn('B', 'Silhana Ledgewalker Test', 'battlefield', true) // tapped, B controls

    await s.as('A').putOnStack('gain_control_creature', {
      target_card_id: prey,
      duration: 'end_of_turn',
      untap: true,
      haste: true,
      target_controller: 'opponent',
    })
    await s.resolveStack()

    let preyState = await s.cardState(prey)
    assert.equal(preyState.controller_player_id, s.playerId('A')) // caster controls it
    assert.equal(preyState.is_tapped, false) // untapped
    assert.equal(await s.continuousEffectCount(prey, 'haste'), 1) // gained haste
    assert.equal(await s.continuousEffectCount(prey, 'control'), 1) // until-EOT control row

    await s.as('A').expireEffects('ending', 'cleanup')

    preyState = await s.cardState(prey)
    assert.equal(preyState.controller_player_id, s.playerId('B')) // reverted to owner
    assert.equal(await s.continuousEffectCount(prey, 'control'), 0)
    assert.equal(await s.continuousEffectCount(prey, 'haste'), 0)
  })
})

// GC5 — SPELL controller restriction: "you don't control" rejects your own
// creature at cast time.
test('GC5 gain_control_creature spell rejects your own creature (opponent-only)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const own = await s.spawnCreature('A', 'Welcome Drain Test')

    await assert.rejects(() =>
      s.as('A').putOnStack('gain_control_creature', {
        target_card_id: own,
        duration: 'permanent',
        target_controller: 'opponent',
      }),
    )
  })
})
