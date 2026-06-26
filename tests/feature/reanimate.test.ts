// Reanimate / Animate Dead (mig 346). The reanimation is return_from_graveyard
// (from:'all_graveyards', control:'decider') — which already works in the spell
// resolver (the workflow's reanimate_from_graveyard does NOT). Reanimate adds a
// lose_life_mana_value rider: the caster loses life equal to the reanimated card's
// mana value.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

const REANIMATE = [{ type: 'return_from_graveyard', to: 'battlefield', count: 1, from: 'all_graveyards', control: 'decider', filter: { type_line: 'creature' }, lose_life_mana_value: true }]

// RE1 — reanimate a creature from any graveyard under your control, losing life = MV.
test('RE1 Reanimate fields a graveyard creature and loses life equal to its MV', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const target = await s.spawn('B', 'Big Vampire Test', 'graveyard') // {5} → MV 5, in B's graveyard
    const lifeA = await s.lifeOf('A')

    await s.as('A').castSpellEffect(REANIMATE)
    await s.as('A').resolveStack() // parks the graveyard pick
    const d = await s.pendingDecision()
    assert.equal(d?.decision_type, 'return_from_graveyard')
    await s.as('A').submitDecision(d!.id, { chosen: [target] })

    const st = await s.cardState(target)
    assert.equal(st.zone, 'battlefield', 'reanimated to the battlefield')
    assert.equal(st.controller_player_id, s.playerId('A'), 'under the caster\'s control')
    assert.equal(await s.lifeOf('A'), lifeA - 5, 'lost life equal to mana value (5)')
  })
})

// RE2 — Animate Dead (no life rider) reanimates without the life loss.
test('RE2 Animate Dead reanimates without losing life', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const target = await s.spawn('A', 'Big Vampire Test', 'graveyard')
    const lifeA = await s.lifeOf('A')

    await s.as('A').castSpellEffect(
      [{ type: 'return_from_graveyard', to: 'battlefield', count: 1, from: 'all_graveyards', control: 'decider', filter: { type_line: 'creature' } }])
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { chosen: [target] })

    assert.equal((await s.cardState(target)).zone, 'battlefield')
    assert.equal(await s.lifeOf('A'), lifeA, 'no life lost')
  })
})
