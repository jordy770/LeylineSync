import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => { await ensureTestCards() })

test('CX1 casting a cascade permanent enqueues a cascade trigger', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Cascade Bear Test', 'library') // MV 2 < 5 window (a cheaper cascade target)
    const wurm = await s.spawn('A', 'Cascade Wurm Test', 'hand')    // {4}{G} = MV 5
    await s.setMana('A', { G: 1, C: 4 })
    await s.as('A').castPermanent(wurm)

    const stack = await s.pendingStack()
    const cascade = stack.find((i) => i.action_type === 'triggered_ability'
      && Array.isArray((i.payload.effects as unknown[]))
      && JSON.stringify(i.payload.effects).includes('"cascade"'))
    assert.ok(cascade, 'a cascade trigger is on the stack above the wurm')
  })
})

function hasCascadeTrigger(stack: { action_type: string; payload: Record<string, unknown> }[]) {
  return stack.some((i) => i.action_type === 'triggered_ability'
    && Array.isArray(i.payload.effects as unknown[])
    && JSON.stringify(i.payload.effects).includes('"cascade"'))
}

test('CX2 a targeted cascade spell found via cast_card_free re-cascades (targeted branch fires the hook)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('B', 'Grave Shambler Test') // a legal target so the parked spell is sane
    const targeted = await s.spawn('A', 'Cascade Targeted Test', 'exile') // Cascade + destroy target creature
    await s.as('A')
    await client.query('select public.cast_card_free($1, $2, $3)', [s.sessionId, targeted, s.playerId('A')])
    assert.ok(hasCascadeTrigger(await s.pendingStack()),
      'the targeted branch of cast_card_free enqueues the found spell\'s own cascade')
  })
})

test('CX3 the bare `cascade: true` form also fires the hook', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Cascade Bear Test', 'library')
    const boolCard = await s.spawn('A', 'Cascade Bool Test', 'hand') // {4}{G}, script cascade:true
    await s.setMana('A', { G: 1, C: 4 })
    await s.as('A').castPermanent(boolCard)
    assert.ok(hasCascadeTrigger(await s.pendingStack()), 'cascade:true enqueues a cascade trigger')
  })
})
