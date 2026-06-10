// Enters-tapped lands (mig 217) — top-level `enters_tapped` read in
// cast_card_from_hand's land branch: plain true (Salt Marsh), a count
// condition (Sunken Hollow "unless you control two or more basic lands"), or
// a hand check (Choked Estuary's reveal, auto-applied). ETB lifegain on a land
// (Jwar Isle Refuge) is an ordinary trigger and composes.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function tapped(s: Scenario, id: string): Promise<boolean> {
  const r = await s.client.query<{ t: boolean }>(
    'select is_tapped as t from public.game_cards where id = $1', [id])
  return r.rows[0]!.t
}

// EL1 — plain enters_tapped, plus the ETB lifegain composing on Jwar Isle Refuge.
test('EL1 a tapland enters tapped; its ETB lifegain still fires', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const refuge = await s.spawn('A', 'Jwar Isle Refuge Test', 'hand')
    const before = await s.lifeOf('A')

    await s.as('A').castPermanent(refuge)
    assert.equal(await tapped(s, refuge), true)

    await s.as('A').resolveStack() // the ETB gain-1 trigger
    assert.equal(await s.lifeOf('A'), before + 1)
  })
})

// EL2 — Sunken Hollow: tapped with one basic, untapped with two.
test('EL2 Sunken Hollow checks your basic-land count', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A', turnNumber: 1 })
    await s.spawn('A', 'Wastes Test', 'battlefield') // one basic
    const first = await s.spawn('A', 'Sunken Hollow Test', 'hand')
    await s.as('A').castPermanent(first)
    assert.equal(await tapped(s, first), true) // only 1 basic

    await s.spawn('A', 'Island Test', 'battlefield') // now 2 basics
    await s.client.query('update public.game_turn_state set lands_played_this_turn = 0 where session_id = $1', [s.sessionId])
    const second = await s.spawn('A', 'Sunken Hollow Test', 'hand')
    await s.as('A').castPermanent(second)
    assert.equal(await tapped(s, second), false) // condition held
  })
})

// EL3 — Choked Estuary: untapped when your hand holds an Island or Swamp.
test('EL3 Choked Estuary checks your hand', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A', turnNumber: 1 })
    const first = await s.spawn('A', 'Choked Estuary Test', 'hand')
    await s.as('A').castPermanent(first)
    assert.equal(await tapped(s, first), true) // nothing to reveal

    await s.spawn('A', 'Island Test', 'hand') // an Island to reveal
    await s.client.query('update public.game_turn_state set lands_played_this_turn = 0 where session_id = $1', [s.sessionId])
    const second = await s.spawn('A', 'Choked Estuary Test', 'hand')
    await s.as('A').castPermanent(second)
    assert.equal(await tapped(s, second), false)
  })
})

// EL4 — a normal land still enters untapped.
test('EL4 plain lands are unaffected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const wastes = await s.spawn('A', 'Wastes Test', 'hand')
    await s.as('A').castPermanent(wastes)
    assert.equal(await tapped(s, wastes), false)
  })
})
