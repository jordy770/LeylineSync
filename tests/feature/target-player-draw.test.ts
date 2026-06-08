// "Target player draws N cards" (Deep Analysis) is modelled as choose_player
// wrapping a draw: the caster chooses a player, then the engine forces the inner
// effect onto THAT player (choose_player rewrites each inner effect's recipient
// to the chosen player). This pins the semantics the form now labels correctly
// ("Choose a player, then that player: Draw cards" — not "You draw cards").

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// DA1 — choose_player(any) → draw makes the CHOSEN player draw, not the caster.
test('DA1 choose_player draw targets the chosen player, not the caster', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('B', 'Air Elemental Test', 'library')
    await s.spawn('B', 'Air Elemental Test', 'library')
    const aBefore = await s.zoneCount('A', 'hand')
    const bBefore = await s.zoneCount('B', 'hand')

    await s.as('A').castSpellEffect([
      { type: 'choose_player', filter: 'any', effects: [{ type: 'draw', amount: 2 }] },
    ])
    await s.as('A').resolveStack()

    const decision = await s.pendingDecision()
    assert.equal(decision?.decision_type, 'choose_player')
    // 'any' filter offers both players; the caster directs the draw at the opponent.
    await s.as('A').submitDecision(decision!.id, { player_id: s.players.B })

    assert.equal(await s.zoneCount('B', 'hand'), bBefore + 2) // chosen player drew 2
    assert.equal(await s.zoneCount('A', 'hand'), aBefore) // caster did NOT draw
  })
})

// DA2 — the caster may target themselves (Deep Analysis "target player" can be you).
test('DA2 choose_player draw can target the caster', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Air Elemental Test', 'library')
    await s.spawn('A', 'Air Elemental Test', 'library')
    const aBefore = await s.zoneCount('A', 'hand')

    await s.as('A').castSpellEffect([
      { type: 'choose_player', filter: 'any', effects: [{ type: 'draw', amount: 2 }] },
    ])
    await s.as('A').resolveStack()

    const decision = await s.pendingDecision()
    await s.as('A').submitDecision(decision!.id, { player_id: s.players.A })

    assert.equal(await s.zoneCount('A', 'hand'), aBefore + 2)
  })
})
