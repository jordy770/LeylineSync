// Victimize (mig 218) — "Choose two target creature cards in your graveyard.
// Sacrifice a creature. If you do, return the chosen cards to the battlefield
// tapped." Composed as [sacrifice you 1, return_from_graveyard battlefield 2
// tapped:true] — the new `tapped` option on the return.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function isTapped(s: Scenario, id: string): Promise<boolean> {
  const r = await s.client.query<{ t: boolean }>(
    'select is_tapped as t from public.game_cards where id = $1', [id])
  return r.rows[0]!.t
}

// VZ1 — sac one, return two tapped.
test('VZ1 sacrifice, then return two creatures tapped', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const fodder = await s.spawnCreature('A', 'Goblin Raider Test')
    const dead1 = await s.spawn('A', 'Grave Shambler Test', 'graveyard')
    const dead2 = await s.spawn('A', 'Grave Shambler Test', 'graveyard')

    await s.as('A').castSpellEffect([
      { type: 'sacrifice', who: 'you', count: 1 },
      { type: 'return_from_graveyard', to: 'battlefield', count: 2, tapped: true },
    ])
    await s.as('A').resolveStack()

    // First decision: the sacrifice.
    let d = await s.pendingDecision()
    assert.equal(d?.decision_type, 'sacrifice')
    await s.as('A').submitDecision(d!.id, { chosen: [fodder] })
    assert.equal(await s.zoneOf(fodder), 'graveyard')

    // Second decision: pick the two returns.
    d = await s.pendingDecision()
    assert.equal(d?.decision_type, 'return_from_graveyard')
    await s.as('A').submitDecision(d!.id, { chosen: [dead1, dead2] })

    assert.equal(await s.zoneOf(dead1), 'battlefield')
    assert.equal(await s.zoneOf(dead2), 'battlefield')
    assert.equal(await isTapped(s, dead1), true) // enters TAPPED
    assert.equal(await isTapped(s, dead2), true)
  })
})

// VZ2 — a hand return (Raise Dead style) stays untapped: the flag only affects
// battlefield returns.
test('VZ2 tapped does not leak into hand returns', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const dead = await s.spawn('A', 'Grave Shambler Test', 'graveyard')

    await s.as('A').castSpellEffect([
      { type: 'return_from_graveyard', to: 'hand', count: 1 },
    ])
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { chosen: [dead] })

    assert.equal(await s.zoneOf(dead), 'hand')
    assert.equal(await isTapped(s, dead), false)
  })
})
