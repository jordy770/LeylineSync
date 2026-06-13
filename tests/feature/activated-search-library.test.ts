// search_library as an ACTIVATED-ability effect (mig 187). Wayfarer's Bauble:
// "{1}, {T}, Sacrifice Wayfarer's Bauble: Search your library for a basic land
// card, put it onto the battlefield tapped, then shuffle." The tutor parks a
// decision; the ability routes it through a spell_effect stack item (like
// create_token), and the sacrifice_self cost is paid up front.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// WB1 — activate: source is sacrificed as a cost, then the tutor parks a decision;
// the chosen basic land enters the battlefield tapped under the controller.
test('WB1 sacrifices the source and fetches a basic land onto the battlefield tapped', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bauble = await s.spawn('A', "Wayfarer's Bauble Test", 'battlefield')
    const land = await s.spawn('A', 'Wastes Test', 'library')
    await s.spawn('A', 'Air Elemental Test', 'library') // a non-land — must not be offered
    await s.setMana('A', { C: 1 }) // {1}

    await s.as('A').activate(bauble, 0)
    assert.equal(await s.zoneOf(bauble), 'graveyard') // sacrificed as a cost

    assert.equal((await s.as('A').resolveStack()).awaiting_decision, true)
    const d = await s.pendingDecision()
    const opts = d?.options as { game_card_id: string }[]
    assert.equal(opts.length, 1) // only the basic land is a legal choice
    assert.equal(opts[0].game_card_id, land)

    await s.as('A').submitDecision(d!.id, { chosen: [land] })
    const st = await s.cardState(land)
    assert.equal(st.zone, 'battlefield')
    assert.equal(st.is_tapped, true)
    assert.equal(st.controller_player_id, s.playerId('A'))
  })
})

// WB2 — the {1} cost is required: without the mana, activation is rejected and the
// source is untouched.
test('WB2 activation without the mana cost is rejected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bauble = await s.spawn('A', "Wayfarer's Bauble Test", 'battlefield')
    await s.spawn('A', 'Wastes Test', 'library')

    await client.query('savepoint sp_wb2')
    await assert.rejects(() => s.as('A').activate(bauble, 0))
    await client.query('rollback to savepoint sp_wb2')

    assert.equal(await s.zoneOf(bauble), 'battlefield') // not sacrificed
  })
})
