// Dig Through Time (mig 302): look at the top 7, put 2 into your hand, the rest
// on the bottom. Exercises look_top with to:'hand' and picks:2. (Delve — the
// graveyard-exile cost reduction — is not modelled; cast at full cost.)

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// DIG1 — digging 7 and taking 2 adds two cards to hand and removes them from the
// library (the other 5 go to the bottom).
test('DIG1 Dig Through Time puts two of the top seven into hand', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const dig = await s.spawn('A', 'Dig Test', 'hand')
    for (let i = 0; i < 7; i++) await s.spawn('A', 'Air Elemental Test', 'library')

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { U: 2, C: 6 })
    const handBefore = await s.zoneCount('A', 'hand')
    const libBefore = await s.zoneCount('A', 'library')

    await s.as('A').castSpellEffect(
      [{ type: 'look_top', count: 7, to: 'hand', picks: 2, min_picks: 2 }],
      dig,
    )
    await s.as('A').resolveStack() // the spell resolves and parks the look_top pick
    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'look_top')
    const opts = d!.options as { game_card_id: string }[]
    await s.as('A').submitDecision(d!.id, { chosen: [opts[0].game_card_id, opts[1].game_card_id] })

    // Dig left hand (-1, cast to graveyard) then +2 drawn.
    assert.equal(await s.zoneCount('A', 'hand'), handBefore - 1 + 2)
    assert.equal(await s.zoneCount('A', 'library'), libBefore - 2)
  })
})
