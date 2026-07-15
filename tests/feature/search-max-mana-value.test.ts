// mig 400 — search_library filter.max_mana_value (Trinket Mage: "an artifact
// card with mana value 1 or less"): the parked decision's options — which are
// also the submit whitelist — drop cards over the cap.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// SMV1 — the {1} bauble is offered; the {2} Wellspring is not; the pick lands in hand.
test('SMV1 search options respect max_mana_value', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bauble = await s.spawn('A', 'Cheap Bauble Test', 'library')
    await s.spawn('A', 'Ichor Wellspring Test', 'library') // {2} — over the cap

    await s.spawnCreature('A', 'Trinket Tutor Test')
    await s.as('A').resolveStack()

    const d = (await s.pendingDecision()) as { id: string; options: Array<{ game_card_id: string; name: string }> }
    assert.ok(d, 'search decision parked')
    assert.deepEqual(d.options.map((o) => o.name), ['Cheap Bauble Test'])

    await s.as('A').submitDecision(d.id, { chosen: [bauble] })
    assert.equal(await s.zoneOf(bauble), 'hand')
  })
})
