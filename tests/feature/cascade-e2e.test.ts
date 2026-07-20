// mig 418-423 — cascade end-to-end: cast a cascade card from hand → the cast hook
// enqueues the cascade trigger → resolving it parks the may-cast decision → accepting
// truly casts the found card. Plus recursion: a found cascade spell cascades again.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => { await ensureTestCards() })

const firstOption = (dec: { options: unknown }) =>
  (dec.options as { game_card_id: string }[])[0].game_card_id

test('E2E1 cast-from-hand cascade: trigger fires, accept, the cheaper permanent enters', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bear = await s.spawn('A', 'Cascade Bear Test', 'library') // MV 2 < 5
    const wurm = await s.spawn('A', 'Cascade Wurm Test', 'hand')     // {4}{G} = MV 5, cascade
    await s.setMana('A', { G: 1, C: 4 })
    await s.as('A').castPermanent(wurm)

    await s.as('A').resolveStack() // cascade trigger → parks cascade_cast
    const dec = await s.pendingDecision()
    assert.equal(dec!.decision_type, 'cascade_cast')
    await s.as('A').submitDecision(dec!.id, { chosen: [firstOption(dec!)] })

    await s.as('A').resolveStack() // the found bear (cast_permanent) resolves
    assert.equal(await s.zoneOf(bear), 'battlefield')
    await s.as('A').resolveStack() // the wurm itself resolves
    assert.equal(await s.zoneOf(wurm), 'battlefield')
  })
})

test('E2E2 recursion: a found cascade spell cascades again', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    // library top→bottom: Chain (MV3 < 5, cascade+draw), then Bear (MV2 < 3), then a draw target
    const chain = await s.spawn('A', 'Cascade Chain Test', 'library')
    const bear = await s.spawn('A', 'Cascade Bear Test', 'library')
    await s.spawn('A', 'Grave Shambler Test', 'library') // something for Chain's draw to pull
    const wurm = await s.spawn('A', 'Cascade Wurm Test', 'hand') // MV 5
    await s.setMana('A', { G: 1, C: 4 })
    await s.as('A').castPermanent(wurm)

    await s.as('A').resolveStack() // wurm's cascade → parks cascade_cast (offers Chain)
    let dec = await s.pendingDecision()
    assert.equal(firstOption(dec!), chain)
    await s.as('A').submitDecision(dec!.id, { chosen: [chain] }) // cast Chain (free)

    // Chain's own cascade trigger is now on the stack; resolve it → parks again (offers Bear)
    await s.as('A').resolveStack()
    dec = await s.pendingDecision()
    assert.equal(dec!.decision_type, 'cascade_cast')
    assert.equal(firstOption(dec!), bear)
    await s.as('A').submitDecision(dec!.id, { chosen: [bear] })

    await s.as('A').resolveStack() // the found bear resolves
    assert.equal(await s.zoneOf(bear), 'battlefield')
  })
})
