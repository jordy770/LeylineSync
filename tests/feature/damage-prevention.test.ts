// Phase 4 / F2.1a — damage prevention resolver (mig 125). A shield consumes damage
// before it reaches a player's life. These drive the resolver via the targeted
// deal_damage_player path; shields are created directly (the prevent_damage card
// effect that calls add_damage_prevention is F2.1b).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// A deals `amount` damage to a player via a targeted deal_damage_player spell.
async function bolt(s: Scenario, target: 'A' | 'B' | 'C', amount: number) {
  await s.as('A').putOnStack('deal_damage_player', { target_player_id: s.playerId(target), amount })
  await s.as('A').resolveStack()
}

// A attacks B unblocked with a fresh creature; returns after combat damage.
async function attackUnblocked(s: Scenario, attackerName: string) {
  const atk = await s.spawnCreature('A', attackerName)
  await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
  await s.as('A').declareAttacker(atk, 'B')
  await s.setTurn({ phase: 'combat', step: 'combat_damage', active: 'A', priority: 'A' })
  await s.as('A').resolveCombat()
}

// DP1 — a numeric shield reduces incoming damage by its amount, then is consumed.
test('DP1 a shield prevents its amount of damage', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const start = await s.lifeOf('B')

    await s.addPrevention('B', 2)
    await bolt(s, 'B', 5)

    assert.equal(await s.lifeOf('B'), start - 3) // 5 - 2 prevented
  })
})

// DP2 — a prevent-all shield (amount null) stops everything and persists.
test('DP2 a prevent-all shield stops all damage', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const start = await s.lifeOf('B')

    await s.addPrevention('B', null)
    await bolt(s, 'B', 4)
    await bolt(s, 'B', 3) // still prevented — the shield persists

    assert.equal(await s.lifeOf('B'), start)
  })
})

// DP3 — a combat-only shield does NOT prevent spell/ability (non-combat) damage.
test('DP3 a combat-only shield ignores non-combat damage', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const start = await s.lifeOf('B')

    await s.addPrevention('B', 5, true) // combat-only
    await bolt(s, 'B', 3) // a spell — not combat

    assert.equal(await s.lifeOf('B'), start - 3)
  })
})

// DP4 — a shield is consumed across multiple hits until exhausted.
test('DP4 a shield is consumed across multiple events', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const start = await s.lifeOf('B')

    await s.addPrevention('B', 3)
    await bolt(s, 'B', 2) // prevents 2, shield -> 1, B loses 0
    await bolt(s, 'B', 2) // prevents 1, shield gone, B loses 1

    assert.equal(await s.lifeOf('B'), start - 1)
  })
})

// PV1 — F2.1b: casting a prevent_damage spell creates the shield (controller =
// caster). B shields itself for 3, then A's 5-damage spell deals only 2.
test('PV1 a prevent_damage spell shields its caster', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'B' })
    const start = await s.lifeOf('B')

    await s.as('B').castSpellEffect([{ type: 'prevent_damage', amount: 3 }])
    await s.as('B').resolveStack()

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await bolt(s, 'B', 5)

    assert.equal(await s.lifeOf('B'), start - 2) // 5 - 3 prevented
  })
})

// PV2 — a prevent_damage spell with no amount shields against ALL damage.
test('PV2 prevent_damage without an amount prevents all', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'B' })
    const start = await s.lifeOf('B')

    await s.as('B').castSpellEffect([{ type: 'prevent_damage' }])
    await s.as('B').resolveStack()

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await bolt(s, 'B', 6)

    assert.equal(await s.lifeOf('B'), start)
  })
})

// CP1 — F2.1c: a player shield now also stops COMBAT damage. B's 3-shield reduces
// an unblocked 4-power attacker to 1.
test('CP1 a shield prevents combat damage', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const start = await s.lifeOf('B')

    await s.addPrevention('B', 3)
    await attackUnblocked(s, 'Air Elemental Test') // 4/4

    assert.equal(await s.lifeOf('B'), start - 1)
  })
})

// CP2 — a combat-only shield stops combat damage (the inverse of DP3).
test('CP2 a combat-only shield stops combat damage', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const start = await s.lifeOf('B')

    await s.addPrevention('B', 5, true) // combat-only
    await attackUnblocked(s, 'Air Elemental Test') // 4

    assert.equal(await s.lifeOf('B'), start)
  })
})

// CP3 — end-to-end: a prevent_damage spell shields the caster against combat.
test('CP3 a prevent_damage spell shields against combat', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'B' })
    const start = await s.lifeOf('B')

    await s.as('B').castSpellEffect([{ type: 'prevent_damage', amount: 3 }])
    await s.as('B').resolveStack()

    await attackUnblocked(s, 'Air Elemental Test') // 4 -> 1 after the 3-shield

    assert.equal(await s.lifeOf('B'), start - 1)
  })
})
