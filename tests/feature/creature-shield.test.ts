// Phase 4 / F2.1d — creature damage shields (mig 147). The creature analogue of the
// player prevention resolver (mig 125): a shield consumes targeted spell/ability
// damage before it is marked. Tests drive the targeted path (deal_damage_creature)
// with shields created via add_creature_damage_prevention, mirroring DP1-4.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// Air Elemental Test is a 4/4 — survives a few points so we can read damage_marked.
const damageMarked = async (s: Scenario, card: string) =>
  Number((await s.cardState(card)).damage_marked)

// CS1 — a shield larger than the damage absorbs it all; nothing is marked.
test('CS1 a shield absorbs the damage', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const c = await s.spawnCreature('A', 'Air Elemental Test')
    await s.addCreaturePrevention(c, 3)

    await s.as('A').putOnStack('deal_damage_creature', { target_card_id: c, amount: 2 })
    await s.resolveStack()

    assert.equal(await damageMarked(s, c), 0) // 2 absorbed by the 3-shield
    assert.equal(await s.zoneOf(c), 'battlefield')
  })
})

// CS2 — a numeric shield only prevents up to its amount; the rest is marked.
test('CS2 a shield prevents up to its amount', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const c = await s.spawnCreature('A', 'Air Elemental Test') // 4/4
    await s.addCreaturePrevention(c, 1)

    await s.as('A').putOnStack('deal_damage_creature', { target_card_id: c, amount: 3 })
    await s.resolveStack()

    assert.equal(await damageMarked(s, c), 2) // 1 prevented, 2 marked; 4/4 survives
    assert.equal(await s.zoneOf(c), 'battlefield')
  })
})

// CS3 — lethal still gets through once the shield is spent.
test('CS3 lethal damage past the shield kills the creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const c = await s.spawnCreature('A', 'Air Elemental Test') // 4/4
    await s.addCreaturePrevention(c, 1)

    await s.as('A').putOnStack('deal_damage_creature', { target_card_id: c, amount: 5 })
    await s.resolveStack() // 1 prevented, 4 marked = lethal

    assert.equal(await s.zoneOf(c), 'graveyard')
  })
})

// CS4 — a prevent-all shield (amount null) stops everything.
test('CS4 a prevent-all shield stops all damage', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const c = await s.spawnCreature('A', 'Air Elemental Test')
    await s.addCreaturePrevention(c, null) // prevent all

    await s.as('A').putOnStack('deal_damage_creature', { target_card_id: c, amount: 5 })
    await s.resolveStack()

    assert.equal(await damageMarked(s, c), 0)
    assert.equal(await s.zoneOf(c), 'battlefield')
  })
})

// CS5 — a combat_only shield does NOT stop targeted spell/ability damage.
test('CS5 a combat-only shield ignores spell damage', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const c = await s.spawnCreature('A', 'Air Elemental Test') // 4/4
    await s.addCreaturePrevention(c, 3, true) // combat only

    await s.as('A').putOnStack('deal_damage_creature', { target_card_id: c, amount: 2 })
    await s.resolveStack()

    assert.equal(await damageMarked(s, c), 2) // not combat → shield inert
  })
})
