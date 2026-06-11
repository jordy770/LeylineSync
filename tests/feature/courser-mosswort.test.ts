// mig 248 — Hellkite Courser + Mosswort Bridge.
//   • Hellkite Courser: ETB may put a commander you own from the command zone
//     onto the battlefield with haste; it returns to the command zone when
//     the end step is left (return_to_command marker in advance_step).
//   • Mosswort Bridge (hideaway): ETB look at the top 4, exile one (mandatory
//     pick, remembered on the land), rest to the bottom in a random order;
//     "{G}, {T}: play it free if your creatures' total power is 10+" — the
//     condition gate's new count form. Instants/sorceries hidden away are not
//     playable (approximation).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// HC1 — borrow the commander, then it goes home at the end step.
test('HC1 Hellkite Courser borrows a commander until the end step', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    // dev_spawn_card has no command zone; spawn then move the row there.
    const cmd = await s.spawn('A', 'Leyline Tyrant Test', 'hand')
    await s.client.query(
      `update public.game_cards set zone = 'command', zone_position = 0, is_commander = true where id = $1`,
      [cmd])

    await s.spawnCreature('A', 'Hellkite Courser Test')
    await s.as('A').resolveStack() // ETB -> command_zone_pick
    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'command_zone_pick')
    await s.as('A').submitDecision(d!.id, { chosen: [cmd] })

    let row = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [cmd])
    assert.equal(row.rows[0]!.zone, 'battlefield')
    const haste = await s.client.query(
      `select 1 from public.game_continuous_effects
       where session_id = $1 and affected_card_id = $2 and effect_type = 'haste'`,
      [s.sessionId, cmd])
    assert.ok(haste.rows.length >= 1)

    // Leaving the end step sends it home.
    await s.setTurn({ phase: 'ending', step: 'end', active: 'A', priority: 'A' })
    await s.as('A').advanceStep('A')
    row = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [cmd])
    assert.equal(row.rows[0]!.zone, 'command')
  })
})

// MB1 — hideaway: exile one of four, bottom the rest, then play it free at 10+ power.
test('MB1 Mosswort Bridge hides a card and plays it behind the power gate', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const hit = await s.spawn('A', 'Leyline Tyrant Test', 'library') // will be hidden
    for (let i = 0; i < 3; i++) await s.spawn('A', 'Wastes Test', 'library')

    const bridge = await s.spawn('A', 'Mosswort Bridge Test', 'battlefield')
    await s.as('A').resolveStack() // ETB -> hideaway look
    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'look_top')
    assert.equal(d!.min_choices, 1) // exiling one is mandatory
    assert.equal((d!.options as unknown[]).length, 4)
    await s.as('A').submitDecision(d!.id, { chosen: [hit] })

    const hidden = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [hit])
    assert.equal(hidden.rows[0]!.zone, 'exile')
    const lib = await s.client.query<{ n: string }>(
      `select count(*)::int as n from public.game_cards
       where session_id = $1 and owner_id = $2 and zone = 'library'`,
      [s.sessionId, s.players.A])
    assert.equal(Number(lib.rows[0]!.n), 3) // the rest went to the bottom

    // Two 5/5s = total power 10: the gate opens.
    await s.spawnCreature('A', 'Dragon Token')
    await s.spawnCreature('A', 'Dragon Token')
    await s.setMana('A', { G: 1 })
    await s.as('A').activate(bridge, 1)
    await s.as('A').resolveStack()

    const played = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [hit])
    assert.equal(played.rows[0]!.zone, 'battlefield')
  })
})

// MB2 — below ten total power the activation is refused (rejection last).
test('MB2 Mosswort Bridge refuses the play below ten power', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const hit = await s.spawn('A', 'Leyline Tyrant Test', 'library')
    const bridge = await s.spawn('A', 'Mosswort Bridge Test', 'battlefield')
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { chosen: [hit] })

    await s.spawnCreature('A', 'Dragon Token') // only 5 power
    await s.setMana('A', { G: 1 })
    await assert.rejects(
      () => s.as('A').activate(bridge, 1),
      /cannot be activated right now/)
  })
})
