// mig 255 — the Veloci-Ramp-Tor manabase + ramp batch (~20 script-only
// cards). Spot checks for the new shapes:
//   • reveal lands: enters_tapped unless hand_has_type (Fortified Village).
//   • Arch of Orazca: the city's blessing approximated as a live
//     permanents_you_control >= 10 condition (new count).
//   • Myriad Landscape: {2},{T},sac for two basics ("of the same type" not
//     enforced — approximation).
//   • Otepec Huntmaster: Dino cost reduction + tap-to-haste.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// DM1 — Fortified Village enters untapped with a Forest-typed card in hand,
// tapped without one.
test('DM1 reveal land checks the hand for the named types', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    await s.spawn('A', 'Island Test', 'hand') // not Forest/Plains
    const tapped = await s.spawn('A', 'Fortified Village Test', 'hand')
    await s.as('A').castPermanent(tapped)
    let row = await s.client.query<{ is_tapped: boolean }>(
      'select is_tapped from public.game_cards where id = $1', [tapped])
    assert.equal(row.rows[0]!.is_tapped, true)

    await s.client.query(
      'update public.game_turn_state set lands_played_this_turn = 0 where session_id = $1',
      [s.sessionId])
    await s.spawn('A', 'Forest Test', 'hand') // a revealable Forest
    const untapped = await s.spawn('A', 'Fortified Village Test', 'hand')
    await s.as('A').castPermanent(untapped)
    row = await s.client.query<{ is_tapped: boolean }>(
      'select is_tapped from public.game_cards where id = $1', [untapped])
    assert.equal(row.rows[0]!.is_tapped, false)
  })
})

// DM2 — Arch of Orazca: refused below ten permanents, draws at ten.
test('DM2 Arch of Orazca draw is gated on ten permanents', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const arch = await s.spawn('A', 'Arch of Orazca Test', 'battlefield')
    for (let i = 0; i < 9; i++) await s.spawn('A', 'Wastes Test', 'battlefield') // 10 total
    await s.spawn('A', 'Island Test', 'library')

    await s.setMana('A', { C: 5 })
    await s.as('A').activate(arch, 1)
    await s.as('A').resolveStack()

    const hand = await s.client.query<{ n: string }>(
      `select count(*)::int as n from public.game_cards
       where session_id = $1 and owner_id = $2 and zone = 'hand'`,
      [s.sessionId, s.players.A])
    assert.equal(Number(hand.rows[0]!.n), 1)
  })
})

// DM3 — below the blessing the activation is rejected (rejection last).
test('DM3 Arch of Orazca refuses without the blessing', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const arch = await s.spawn('A', 'Arch of Orazca Test', 'battlefield')
    await s.setMana('A', { C: 5 })

    await assert.rejects(
      () => s.as('A').activate(arch, 1),
      /cannot be activated right now/)
  })
})

// DM4 — Myriad Landscape fetches two basics tapped; Otepec hastes a Dino.
test('DM4 Myriad Landscape fetches two; Otepec grants haste', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const land = await s.spawn('A', 'Myriad Landscape Test', 'battlefield')
    const b1 = await s.spawn('A', 'Island Test', 'library')
    const b2 = await s.spawn('A', 'Wastes Test', 'library')

    await s.setMana('A', { C: 2 })
    await s.as('A').activate(land, 1)
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'search_library')
    assert.equal(d!.max_choices, 2)
    await s.as('A').submitDecision(d!.id, { chosen: [b1, b2] })
    const rows = await s.client.query<{ n: string }>(
      `select count(*)::int as n from public.game_cards
       where session_id = $1 and id in ($2, $3) and zone = 'battlefield' and is_tapped`,
      [s.sessionId, b1, b2])
    assert.equal(Number(rows.rows[0]!.n), 2)

    const otepec = await s.spawnCreature('A', 'Otepec Huntmaster Test')
    const dino = await s.spawnCreature('A', 'Dino Grunt Test')
    await s.as('A').activate(otepec, 0, { targetCardId: dino })
    await s.as('A').resolveStack()
    const haste = await s.client.query(
      `select 1 from public.game_continuous_effects
       where session_id = $1 and affected_card_id = $2 and effect_type = 'haste'`,
      [s.sessionId, dino])
    assert.ok(haste.rows.length >= 1)
  })
})
