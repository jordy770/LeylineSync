// mig 422 — the cascade effect handler: exile-until-lesser-MV (shared
// exile_until_cheaper, strict < the cast spell's MV) → "may cast it for free"
// decision → cast_card_free on accept, bottom on decline. Driven here via a
// hand-built cascade trigger so the handler is tested in isolation.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => { await ensureTestCards() })

// Enqueue a bare cascade trigger for A with the given MV window, then it's the top of stack.
async function enqueueCascade(s: Scenario, castMv: number) {
  await s.client.query(
    `insert into public.game_stack_items (session_id, controller_player_id, action_type, payload, position, status)
     select $1::uuid, $2::uuid, 'triggered_ability',
       jsonb_build_object('label','Cascade','controller_player_id',$2::uuid,
         'effects', jsonb_build_array(jsonb_build_object('type','cascade','cast_mana_value',$3::int)),
         'target_required', false, 'timing','triggered'),
       coalesce((select max(position) from public.game_stack_items where session_id=$1::uuid), -1)+1, 'pending'`,
    [s.sessionId, s.playerId('A'), castMv])
}

test('CH1 cascade finds the cheaper nonland and casts it (permanent)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bear = await s.spawn('A', 'Cascade Bear Test', 'library') // {1}{G} = MV 2 < 4
    await enqueueCascade(s, 4)
    await s.as('A').resolveStack() // runs the cascade effect → parks cascade_cast

    const dec = await s.pendingDecision()
    assert.ok(dec && dec.decision_type === 'cascade_cast', 'a cascade_cast decision is parked')
    const opt = (dec!.options as { game_card_id: string }[])[0]
    assert.equal(opt.game_card_id, bear)
    await s.as('A').submitDecision(dec!.id, { chosen: [bear] })
    await s.as('A').resolveStack() // resolve the pushed cast_permanent
    assert.equal(await s.zoneOf(bear), 'battlefield')
  })
})

test('CH2 declining bottoms the found card — never to hand', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bear = await s.spawn('A', 'Cascade Bear Test', 'library')
    await enqueueCascade(s, 4)
    await s.as('A').resolveStack()
    const dec = await s.pendingDecision()
    await s.as('A').submitDecision(dec!.id, { chosen: [] }) // decline
    assert.equal(await s.zoneOf(bear), 'library') // bottomed, still in library
    assert.equal(await s.zoneCount('A', 'hand'), 0)
  })
})

test('CH3 threshold is strict: a card at exactly the cast MV is skipped', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    // Only card is a {1}{G} bear (MV 2). Window MV < 2 → nothing castable.
    const bear = await s.spawn('A', 'Cascade Bear Test', 'library')
    await enqueueCascade(s, 2)
    await s.as('A').resolveStack()
    assert.equal(await s.pendingCount(), 0) // effect completed no-op, no decision
    assert.equal(await s.zoneOf(bear), 'library') // bottomed (looked at, not cast)
  })
})

test('CH4 cascade finds a no-target spell and truly casts it', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const draw = await s.spawn('A', 'Cascade Draw Test', 'library') // top: {1}{U} sorcery MV 2 < 5
    await s.spawn('A', 'Grave Shambler Test', 'library') // below: the card the draw will pull
    await enqueueCascade(s, 5)
    await s.as('A').resolveStack()
    const dec = await s.pendingDecision()
    await s.as('A').submitDecision(dec!.id, { chosen: [draw] })
    await s.as('A').resolveStack() // resolve the spell_effect (draw)
    assert.equal(await s.zoneOf(draw), 'graveyard')
    assert.equal(await s.zoneCount('A', 'hand'), 1)
  })
})
