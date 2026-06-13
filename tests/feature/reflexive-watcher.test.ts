// Reflexive watchers (mig 227) — the entering/attacking creature ITSELF gains
// the effect. Atarka, World Render ("whenever a Dragon you control attacks, it
// gains double strike") and Dragon Tempest ("a creature you control with flying
// enters, it gains haste").

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx, asPlayer } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function has(s: Scenario, seat: 'A' | 'B', fn: string, id: string): Promise<boolean> {
  return asPlayer(s.client, s.players[seat], async () => {
    const r = await s.client.query<{ r: boolean }>(`select public.${fn}($1, $2) as r`, [s.sessionId, id])
    return r.rows[0]!.r
  })
}

// RW1 — Atarka: an attacking Dragon you control gains double strike.
test('RW1 Atarka grants double strike to an attacking Dragon', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Atarka World Render Test')
    const dragon = await s.spawnCreature('A', 'Keiga Test') // a Dragon
    await s.as('A').rebuild()
    assert.equal(await has(s, 'A', 'card_has_double_strike', dragon), false)

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(dragon, 'B') // attacking fires the watcher
    await s.as('A').resolveStack() // the reflexive grant resolves

    assert.equal(await has(s, 'A', 'card_has_double_strike', dragon), true)
  })
})

// RW2 — Atarka ignores a non-Dragon attacker.
test('RW2 Atarka does not buff a non-Dragon', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Atarka World Render Test')
    const goblin = await s.spawnCreature('A', 'Goblin Raider Test')
    await s.as('A').rebuild()

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(goblin, 'B')

    assert.equal((await s.topStackItem()), null) // wrong type → no trigger
    assert.equal(await has(s, 'A', 'card_has_double_strike', goblin), false)
  })
})

// RW3 — Dragon Tempest: a FLYING creature you control entering gains haste; a
// grounder does not.
test('RW3 Dragon Tempest hastes only your fliers', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Dragon Tempest Test')

    const flier = await s.spawnCreature('A', 'Air Elemental Test') // 4/4 flying
    await s.as('A').resolveStack() // the haste grant
    assert.equal(await has(s, 'A', 'card_has_haste', flier), true)

    const grounder = await s.spawnCreature('A', 'Grave Shambler Test') // no flying
    assert.equal((await s.topStackItem()), null) // filtered out
    assert.equal(await has(s, 'A', 'card_has_haste', grounder), false)
  })
})
