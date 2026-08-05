// Bucket-5 slice (mig 438) — damage replacement / prevention / self-damage:
// - self_damage mana-ability cost (pain lands / talismans / Yavimaya Coast):
//   the "deals 1 damage to you" rider is real DAMAGE through
//   apply_damage_to_player (prevention shields apply), not a pay_life cost.
// - damage_double_to_opponents / damage_prevent_half statics (Gisela): applied
//   in apply_damage_to_player before the shield loop — double first, then
//   prevent half rounded up.
// - Scripted deal_damage to players (Eshki) routes through
//   apply_damage_to_player, so shields and Gisela statics apply.
// - opponents_attacked_this_combat count (Drogskol's melee): +1/+1 per
//   opponent you attacked this combat.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// DR1 — the self_damage cost deals real damage: it costs 1 life...
test('DR1 self_damage mana cost costs 1 life', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const land = await s.spawn('A', 'Pain Ability Test', 'battlefield')
    const lifeA = await s.lifeOf('A')

    const pool = await s.as('A').activateMana(land, 0)
    assert.equal(pool.B, 1)
    assert.equal(await s.lifeOf('A'), lifeA - 1)
  })
})

// DR1b — ...and a prevention shield stops it (which pay_life never would).
test('DR1b a prevention shield stops the self_damage rider', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const land = await s.spawn('A', 'Pain Ability Test', 'battlefield')
    await s.as('A').addPrevention('A', 1)
    const lifeA = await s.lifeOf('A')

    const pool = await s.as('A').activateMana(land, 0)
    assert.equal(pool.B, 1)
    assert.equal(await s.lifeOf('A'), lifeA) // damage prevented, mana still added
  })
})

// DR2 — damage dealt to an opponent of the Angel's controller is doubled.
test('DR2 damage to an opponent is doubled by the Angel static', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Angel of Goldnight Test', 'battlefield')
    const lifeB = await s.lifeOf('B')

    await s.as('A').applyDamageToPlayer('B', 3, null)
    assert.equal(await s.lifeOf('B'), lifeB - 6)
  })
})

// DR2b — damage dealt to the Angel's controller is halved (prevent ceil(n/2)).
test('DR2b damage to the controller is halved by the Angel static', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Angel of Goldnight Test', 'battlefield')
    const lifeA = await s.lifeOf('A')

    await s.as('B').applyDamageToPlayer('A', 5, null)
    assert.equal(await s.lifeOf('A'), lifeA - 2) // prevent 3 (rounded up), take 2
  })
})

// DR3 — scripted deal_damage to each opponent respects prevention shields.
test('DR3 scripted player damage routes through prevention', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 3)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const spell = await s.spawn('A', 'Lightning Strike Test', 'hand')
    await s.as('B').addPrevention('B', 3)
    const lifeB = await s.lifeOf('B')
    const lifeC = await s.lifeOf('C')

    await s.as('A').castSpellEffect([{ type: 'deal_damage', amount: 3, recipient: 'each_opponent' }], spell)
    await s.as('A').resolveStack()

    assert.equal(await s.lifeOf('B'), lifeB) // shielded
    assert.equal(await s.lifeOf('C'), lifeC - 3)
  })
})

// DR4 — melee pumps +1/+1 per opponent attacked this combat.
test('DR4 opponents_attacked_this_combat drives the melee pump', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 3)
    const runner = await s.spawnCreature('A', 'Goblin Raider Test')
    const melee = await s.spawnCreature('A', 'Melee Soldier Test')
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })

    await s.as('A').declareAttacker(runner, 'B')
    await s.as('A').declareAttacker(melee, 'C') // both opponents attacked now
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()

    assert.equal(await s.effectivePower(melee), 2 + 2) // base 2 + one per opponent
  })
})
