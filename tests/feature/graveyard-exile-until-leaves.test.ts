// mig 405 — graveyard-target triggers (exile_graveyard_until_leaves), the
// missing half of Trove Warden. A landfall trigger parks a pick over the
// controller's graveyard (permanent cards, mana value <= 3); the chosen card
// is exiled and anchored to the source, so it returns to the battlefield when
// the source dies (via the exiled_until_leaves mechanism, mig 262/404).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// GV1 — landfall exiles a chosen graveyard permanent; killing the Warden
// returns it to the battlefield under its owner.
test('GV1 Trove Warden landfall exiles a graveyard permanent and returns it on death', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const relic = await s.spawn('A', 'Warden Relic Test', 'graveyard') // MV 2 permanent
    const warden = await s.spawnCreature('A', 'Grave Warden Test')

    // A land you control enters → landfall fires → parks the graveyard pick.
    await s.spawn('A', 'Island Test', 'battlefield')
    // Resolve the landfall trigger sitting on the stack; it parks the pick.
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()
    const d = (await s.pendingDecision()) as { id: string; options: Array<{ game_card_id: string; name: string }> }
    assert.ok(d, 'landfall parked a graveyard pick')
    assert.deepEqual(d.options.map((o) => o.name), ['Warden Relic Test'])

    await s.as('A').submitDecision(d.id, { chosen: [relic] })
    assert.equal(await s.zoneOf(relic), 'exile')

    // Warden dies → the exiled card returns to the battlefield under its owner.
    await s.client.query(
      `select public.apply_creature_effect($1, 'destroy', $2, '{}'::jsonb)`,
      [s.sessionId, warden])
    assert.equal(await s.zoneOf(warden), 'graveyard')
    assert.equal(await s.zoneOf(relic), 'battlefield')
  })
})

// GV2 — the MV cap and the permanent filter both trim the option list: a MV-5
// artifact and an instant are not offered, so with no legal card the trigger
// parks no decision.
test('GV2 max_mana_value and permanent filters trim the graveyard options', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Warden Colossus Test', 'graveyard') // MV 5 — over the cap
    await s.spawn('A', 'Warden Bolt Test', 'graveyard') // instant — not a permanent
    await s.spawnCreature('A', 'Grave Warden Test')

    await s.spawn('A', 'Island Test', 'battlefield')
    // No legal graveyard target → the landfall trigger resolves as a no-op.
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()
    assert.equal(await s.pendingDecision(), null)
  })
})

// GV3 — only YOUR graveyard is eligible: an opponent's matching card is not
// offered.
test('GV3 only the controller\'s graveyard is eligible', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('B', 'Warden Relic Test', 'graveyard') // opponent's — ineligible
    const mine = await s.spawn('A', 'Warden Relic Test', 'graveyard')
    await s.spawnCreature('A', 'Grave Warden Test')

    await s.spawn('A', 'Island Test', 'battlefield')
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()
    const d = (await s.pendingDecision()) as { id: string; options: Array<{ game_card_id: string }> }
    assert.ok(d)
    assert.deepEqual(d.options.map((o) => o.game_card_id), [mine])
  })
})
