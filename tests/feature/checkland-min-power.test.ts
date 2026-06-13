// Checklands + the watcher min_power filter (mig 225).
//   Hinterland Harbor — "enters tapped unless you control a Forest or Island."
//   Elemental Bond — "whenever a creature you control with power 3+ enters,
//     draw a card."

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function isTapped(s: Scenario, id: string): Promise<boolean> {
  const r = await s.client.query<{ t: boolean }>('select is_tapped as t from public.game_cards where id = $1', [id])
  return r.rows[0]!.t
}

// CK1 — Hinterland Harbor enters tapped with no qualifying land, untapped with one.
test('CK1 a checkland reads your battlefield', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A', turnNumber: 1 })
    const first = await s.spawn('A', 'Hinterland Harbor Test', 'hand')
    await s.as('A').castPermanent(first)
    assert.equal(await isTapped(s, first), true) // no Forest/Island yet

    await s.spawn('A', 'Island Test', 'battlefield') // now control an Island
    await s.client.query('update public.game_turn_state set lands_played_this_turn = 0 where session_id = $1', [s.sessionId])
    const second = await s.spawn('A', 'Hinterland Harbor Test', 'hand')
    await s.as('A').castPermanent(second)
    assert.equal(await isTapped(s, second), false) // qualifying land present
  })
})

// CK2 — Elemental Bond draws only for power-3+ creatures you control.
test('CK2 min_power watcher fires above the threshold only', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Elemental Bond Test') // an enchantment, really
    await s.spawn('A', 'Air Elemental Test', 'library')
    await s.spawn('A', 'Air Elemental Test', 'library')

    // A 2/2 entering: below threshold, no draw.
    const before1 = await s.zoneCount('A', 'hand')
    await s.spawnCreature('A', 'Grave Shambler Test') // power 2
    assert.equal(await s.pendingDecision(), null)
    assert.equal((await s.topStackItem()), null) // nothing enqueued
    assert.equal(await s.zoneCount('A', 'hand'), before1)

    // A 4/4 entering: at/above threshold → Elemental Bond draws.
    await s.spawnCreature('A', 'Air Elemental Test') // power 4
    await s.as('A').resolveStack()
    assert.equal(await s.zoneCount('A', 'hand'), before1 + 1)
  })
})

// CK3 — an opponent's big creature doesn't trigger your Elemental Bond.
test('CK3 the watcher respects the controller filter', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Elemental Bond Test')
    const before = await s.zoneCount('A', 'hand')

    await s.spawnCreature('B', 'Air Elemental Test') // opponent's 4/4
    assert.equal((await s.topStackItem()), null) // not yours → no trigger
    assert.equal(await s.zoneCount('A', 'hand'), before)
  })
})
