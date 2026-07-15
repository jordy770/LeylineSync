// mig 392 — the four engine features that finish the Talrand precon and remove
// the biggest pipeline approximations:
//   * grant_flashback (Snapcaster Mage): parked graveyard pick → turn-stamped
//     grant honored by cast_spell_effect's graveyard branch.
//   * hand_to_library_top (Brainstorm): mandatory hand pick to the library top.
//   * counter unless_pays (Mana Leak): pay-or-be-countered decision for the
//     TARGET spell's controller.
//   * {power_of:'triggering_creature'} + play_hideaway to:'hand' (Terror of
//     the Peaks / Watcher for Tomorrow).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// SN1 — Snapcaster grants flashback: the chosen graveyard sorcery is castable
// from the graveyard this turn for its mana cost, and exiles on resolution.
test('SN1 Snapcaster grants same-turn flashback to a graveyard spell', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const ideas = await s.spawn('A', 'Blue Ideas Test', 'graveyard') // {2}{U} "draw two"
    for (let i = 0; i < 3; i++) await s.spawn('A', 'Air Elemental Test', 'library')

    await s.spawnCreature('A', 'Snapcaster Mage Test')
    await s.as('A').resolveStack() // ETB trigger parks the graveyard pick

    const decision = await s.pendingDecision()
    assert.ok(decision, 'expected a grant_flashback decision')
    assert.equal(decision!.decision_type, 'grant_flashback')
    await s.as('A').submitDecision(decision!.id, { chosen: [ideas] })

    await s.setMana('A', { C: 2, U: 1 }) // the card's own {2}{U}
    await s.as('A').castSpellEffect([{ type: 'draw', amount: 2 }], ideas)

    assert.equal(await s.zoneOf(ideas), 'exile') // flashback exiles on cast
  })
})

// SN2 — the grant is until END OF TURN: next turn the cast is rejected.
test('SN2 a granted flashback expires with the turn', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const ideas = await s.spawn('A', 'Blue Ideas Test', 'graveyard')
    await s.spawnCreature('A', 'Snapcaster Mage Test')
    await s.as('A').resolveStack()
    const decision = await s.pendingDecision()
    await s.as('A').submitDecision(decision!.id, { chosen: [ideas] })

    // A new turn begins — the stamp no longer matches.
    await s.client.query(
      'update public.game_turn_state set turn_number = turn_number + 1 where session_id = $1',
      [s.sessionId])
    await s.setMana('A', { C: 2, U: 1 })
    await assert.rejects(
      () => s.as('A').castSpellEffect([{ type: 'draw', amount: 2 }], ideas),
      /cannot be cast from your graveyard/i,
    )
  })
})

// BS1 — Brainstorm: draw 3, then the two picked cards go on top of the library
// (the LAST pick ends on top); net +1 card in hand.
test('BS1 Brainstorm puts the picked cards back on top in pick order', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const brainstorm = await s.spawn('A', 'Blue Ideas Test', 'hand') // stand-in cast card
    for (let i = 0; i < 4; i++) await s.spawn('A', 'Air Elemental Test', 'library')
    const handBefore = await s.zoneCount('A', 'hand')

    await s.setMana('A', { C: 2, U: 1 }) // the stand-in card's {2}{U}
    await s.as('A').castSpellEffect(
      [{ type: 'draw', amount: 3 }, { type: 'hand_to_library_top', count: 2 }],
      brainstorm,
    )
    await s.as('A').resolveStack() // draw 3, then park the put-back pick
    const decision = await s.pendingDecision()
    assert.ok(decision, 'expected a hand_to_library_top decision')
    assert.equal(decision!.decision_type, 'hand_to_library_top')
    const options = (decision!.options as { game_card_id: string }[]).map((o) => o.game_card_id)
    const picks = options.slice(0, 2)
    await s.as('A').submitDecision(decision!.id, { chosen: picks })

    // Net: -1 cast, +3 drawn, -2 put back.
    assert.equal(await s.zoneCount('A', 'hand'), handBefore - 1 + 3 - 2)
    // Both picks are in the library; the LAST pick is the very top card.
    const top = await s.client.query(
      `select id from public.game_cards where session_id = $1 and owner_id = $2 and zone = 'library'
       order by zone_position asc limit 2`,
      [s.sessionId, s.players.A])
    assert.equal(top.rows[0].id, picks[1]) // last pick on top
    assert.equal(top.rows[1].id, picks[0])
  })
})

// ML1 — Mana Leak, opponent pays: the spell survives and the {3} leaves their pool.
test('ML1 paying the Mana Leak tax keeps the spell on the stack', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const opt = await s.spawn('A', 'Opt Test', 'hand')
    await s.setMana('A', { C: 1, U: 1 })
    const target = await s.as('A').castSpellEffect([{ type: 'draw', amount: 1 }], opt)

    const leak = await s.spawn('B', 'Mana Leak Test', 'hand')
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'B' })
    await s.setMana('B', { C: 1, U: 1 }) // the Leak's own {1}{U}
    await s.as('B').putOnStack('counter_spell', { target_stack_item_id: target.id }, leak)
    await s.resolveStack() // parks pay_or_be_countered for A

    const decision = await s.pendingDecision()
    assert.ok(decision, 'expected a pay_or_be_countered decision')
    assert.equal(decision!.decision_type, 'pay_or_be_countered')
    assert.equal(decision!.deciding_player_id, s.players.A)

    await s.setMana('A', { C: 3 })
    await s.as('A').submitDecision(decision!.id, { confirmed: true })

    assert.equal(await s.stackStatus(target.id), 'pending') // spell stands
  })
})

// ML2 — declining the tax counters the spell.
test('ML2 declining the Mana Leak tax counters the spell', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const opt = await s.spawn('A', 'Opt Test', 'hand')
    await s.setMana('A', { C: 1, U: 1 })
    const target = await s.as('A').castSpellEffect([{ type: 'draw', amount: 1 }], opt)

    const leak = await s.spawn('B', 'Mana Leak Test', 'hand')
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'B' })
    await s.setMana('B', { C: 1, U: 1 }) // the Leak's own {1}{U}
    await s.as('B').putOnStack('counter_spell', { target_stack_item_id: target.id }, leak)
    await s.resolveStack()

    const decision = await s.pendingDecision()
    await s.as('A').submitDecision(decision!.id, { confirmed: false })

    assert.equal(await s.stackStatus(target.id), 'cancelled')
  })
})

// WT1 — Watcher: hideaway pick on entry; when it leaves the battlefield the
// hidden card goes to its owner's HAND (any type — here a sorcery).
test('WT1 Watcher hides a card and returns it to hand on leaving', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const ideas = await s.spawn('A', 'Blue Ideas Test', 'library') // a sorcery on top
    for (let i = 0; i < 3; i++) await s.spawn('A', 'Air Elemental Test', 'library')

    const watcher = await s.spawnCreature('A', 'Watcher for Tomorrow Test')
    await s.as('A').resolveStack() // ETB look_top(4, to exile)
    const pick = await s.pendingDecision()
    assert.ok(pick, 'expected the hideaway look_top decision')
    await s.as('A').submitDecision(pick!.id, { chosen: [ideas] })
    assert.equal(await s.zoneOf(ideas), 'exile')

    const handBefore = await s.zoneCount('A', 'hand')
    await s.as('A').putInGraveyard(watcher) // leaves the battlefield
    await s.as('A').resolveStack() // LTB trigger: play_hideaway to hand

    assert.equal(await s.zoneOf(ideas), 'hand')
    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 1)
  })
})

// TP1 — Terror of the Peaks: another creature entering lets Terror deal that
// creature's POWER (not Terror's own) to a target creature.
test('TP1 Terror deals the entering creature power to a target creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Terror of the Peaks Test') // 5/4
    const victim = await s.spawnCreature('B', 'Air Elemental Test') // 4/4

    await s.spawnCreature('A', 'Grave Shambler Test') // 2/2 enters → trigger (power 2)
    const trigger = await s.topStackItem()
    assert.ok(trigger, 'expected the Terror trigger on the stack')
    await s.as('A').chooseTriggerTarget(trigger!.id, victim)
    await s.as('A').resolveStack()

    // 2 damage (the ENTERING creature's power, not Terror's 5) — 4/4 survives.
    assert.equal(await s.zoneOf(victim), 'battlefield')
    const marked = await s.client.query(
      'select damage_marked from public.game_cards where id = $1', [victim])
    assert.equal(marked.rows[0].damage_marked, 2)
  })
})
