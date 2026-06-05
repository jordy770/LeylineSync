// Phase 1, slice 14 — search_library variants (mig 111): graveyard destination,
// battlefield-tapped, name filter, and reveal metadata. All cast as untargeted
// spell_effect programs (the same park/resume path the basic tutor uses), so no
// new fixtures are needed — the variant lives entirely in the action payload.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// SLG1 — to:'graveyard' (Entomb): the chosen card goes straight to the graveyard.
test('SLG1 search_library to graveyard entombs the chosen card', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const target = await s.spawn('A', 'Air Elemental Test', 'library')
    await s.spawn('A', 'Deathtouch Viper Test', 'library')

    await s.as('A').castSpellEffect([{ type: 'search_library', to: 'graveyard', count: 1 }])
    assert.equal((await s.as('A').resolveStack()).awaiting_decision, true)

    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { chosen: [target] })

    assert.equal(await s.zoneOf(target), 'graveyard')
    assert.equal(await s.zoneCount('A', 'library'), 1) // the other card remains
  })
})

// SLT1 — to:'battlefield' with tapped:true (Rampant Growth): enters tapped.
test('SLT1 search_library tapped puts the card onto the battlefield tapped', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const target = await s.spawn('A', 'Air Elemental Test', 'library')

    await s.as('A').castSpellEffect([{ type: 'search_library', to: 'battlefield', tapped: true, count: 1 }])
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { chosen: [target] })

    const st = await s.cardState(target)
    assert.equal(st.zone, 'battlefield')
    assert.equal(st.is_tapped, true)
    assert.equal(st.controller_player_id, s.playerId('A'))
  })
})

// SLT2 — the default (no tapped) still enters untapped: guards the new flag.
test('SLT2 search_library to battlefield without tapped enters untapped', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const target = await s.spawn('A', 'Air Elemental Test', 'library')

    await s.as('A').castSpellEffect([{ type: 'search_library', to: 'battlefield', count: 1 }])
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { chosen: [target] })

    assert.equal((await s.cardState(target)).is_tapped, false)
  })
})

// SLN1 — filter.name narrows the options to cards whose name matches.
test('SLN1 search_library filter by name offers only the named card', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Air Elemental Test', 'library')
    const viper = await s.spawn('A', 'Deathtouch Viper Test', 'library')

    await s.as('A').castSpellEffect([{ type: 'search_library', count: 1, filter: { name: 'Viper' } }])
    await s.as('A').resolveStack()

    const d = await s.pendingDecision()
    const opts = d?.options as { game_card_id: string }[]
    assert.equal(opts.length, 1)
    assert.equal(opts[0].game_card_id, viper)
  })
})

// SLR1 — reveal:true records the found card ids in the decision result metadata.
test('SLR1 search_library reveal records the found cards', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const target = await s.spawn('A', 'Air Elemental Test', 'library')

    await s.as('A').castSpellEffect([{ type: 'search_library', to: 'hand', reveal: true, count: 1 }])
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    const row = (await s.as('A').submitDecision(d!.id, { chosen: [target] })) as {
      result: { revealed?: string[] }
    }

    assert.deepEqual(row.result.revealed, [target])
    assert.equal(await s.zoneOf(target), 'hand')
  })
})

// SLR2 — without reveal, no `revealed` key is added (guards the default).
test('SLR2 search_library without reveal omits the revealed metadata', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const target = await s.spawn('A', 'Air Elemental Test', 'library')

    await s.as('A').castSpellEffect([{ type: 'search_library', to: 'hand', count: 1 }])
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    const row = (await s.as('A').submitDecision(d!.id, { chosen: [target] })) as {
      result: { revealed?: string[] }
    }

    assert.equal(row.result.revealed, undefined)
  })
})
