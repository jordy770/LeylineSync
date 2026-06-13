// mig 265 — Breya recursion. Engine touch: return_from_graveyard filter
// gains `types` (Hanna: artifact-or-enchantment) and `exclude_self`
// (Myr Retriever: its own corpse is never offered).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// BR1 — Hanna offers artifacts AND enchantments, returns the pick to hand.
test('BR1 Hanna returns an artifact-or-enchantment card', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const relic = await s.spawn('A', 'Ichor Wellspring Test', 'graveyard')
    await s.spawn('A', 'Wastes Test', 'graveyard') // a LAND — must not be offered
    const hanna = await s.spawnCreature('A', 'Hanna Navigator Test')
    await s.setMana('A', { W: 1, U: 1, C: 1 })

    await s.as('A').activate(hanna, 0)
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'return_from_graveyard')
    const offered = (d!.options as Array<{ name: string }>).map((o) => o.name)
    assert.ok(offered.includes('Ichor Wellspring Test'))
    assert.ok(!offered.includes('Wastes Test'))
    await s.as('A').submitDecision(d!.id, { chosen: [relic] })

    const row = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [relic])
    assert.equal(row.rows[0]!.zone, 'hand')
  })
})

// BR2 — Myr Retriever dies: offers OTHER artifacts only, not itself.
test('BR2 Myr Retriever never offers its own corpse', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const relic = await s.spawn('A', 'Ichor Wellspring Test', 'graveyard')
    const myr = await s.spawnCreature('A', 'Myr Retriever Test')

    await s.putInGraveyard(myr)
    await s.as('A').resolveStack() // the dies-trigger parks the pick
    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'return_from_graveyard')
    const ids = (d!.options as Array<{ game_card_id: string }>).map((o) => o.game_card_id)
    assert.ok(!ids.includes(myr)) // "another target artifact"
    await s.as('A').submitDecision(d!.id, { chosen: [relic] })

    const row = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [relic])
    assert.equal(row.rows[0]!.zone, 'hand')
  })
})
