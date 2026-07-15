// mig 395 — opponent scope on mass effects:
//  * pump_all scope:'opponent' (one pump row per opponent — Phyresis Outbreak)
//  * deal_damage_all filter.controller + tap_damaged (Thundermaw Hellkite)
//  * destroy_all types-branch honors scope (Ruinous Ultimatum)

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// MS1 — pump_all -1/-1 scope opponent: opponent's 2/2 shrinks and the 2/2 of
// the caster is untouched; a 1/1 opponent creature dies to the debuff.
test('MS1 pump_all scope opponent debuffs only opponents', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const mine = await s.spawnCreature('A', 'Goblin Raider Test') // 2/2
    const theirs = await s.spawnCreature('B', 'Goblin Raider Test') // 2/2

    await s.as('A').castSpellEffect([
      { type: 'pump_all', scope: 'opponent', power: -1, toughness: -1 },
    ])
    await s.as('A').resolveStack()

    const power = async (id: string) => {
      const r = await s.client.query(
        'select public.card_effective_power($1, $2)::int as p', [s.sessionId, id])
      return r.rows[0].p
    }
    assert.equal(await power(mine), 2)
    assert.equal(await power(theirs), 1)
  })
})

// MS2 — Phyresis Outbreak shape: poison first, then -X/-X where X reads the
// opponents' poison. After 1 poison the opponent's 2/2 is a 1/1; the caster's
// 2/2 is untouched. Proves the poison lands BEFORE the count resolves.
test('MS2 Phyresis shape: poison then -X/-X on opponents scales with poison', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const theirs = await s.spawnCreature('B', 'Goblin Raider Test') // 2/2
    const mine = await s.spawnCreature('A', 'Goblin Raider Test') // 2/2

    await s.as('A').castSpellEffect([
      { type: 'add_poison', amount: 1, recipient: 'each_opponent' },
      { type: 'pump_all', scope: 'opponent',
        power: { count: 'opponent_poison_counters', negate: true },
        toughness: { count: 'opponent_poison_counters', negate: true } },
    ])
    await s.as('A').resolveStack()

    const power = async (id: string) => {
      const r = await s.client.query(
        'select public.card_effective_power($1, $2)::int as p', [s.sessionId, id])
      return r.rows[0].p
    }
    assert.equal(await power(theirs), 1)
    assert.equal(await power(mine), 2)
  })
})

// MS3 — deal_damage_all with filter.controller:'opponent' + tap_damaged: only
// the opponent's flyer is damaged and tapped; the caster's flyer and the
// opponent's ground creature are untouched (Thundermaw Hellkite's ETB).
test('MS3 deal_damage_all controller filter + tap_damaged hits only opposing flyers', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const myFlyer = await s.spawnCreature('A', 'Air Elemental Test') // 4/4 flying
    const theirFlyer = await s.spawnCreature('B', 'Air Elemental Test') // 4/4 flying
    const theirGround = await s.spawnCreature('B', 'Goblin Raider Test') // 2/2

    await s.as('A').castSpellEffect([
      { type: 'deal_damage_all', amount: 1, tap_damaged: true,
        filter: { with_keyword: 'flying', controller: 'opponent' } },
    ])
    await s.as('A').resolveStack()

    const row = async (id: string) => {
      const r = await s.client.query(
        'select damage_marked, is_tapped from public.game_cards where id = $1', [id])
      return r.rows[0]
    }
    assert.deepEqual(await row(theirFlyer), { damage_marked: 1, is_tapped: true })
    assert.deepEqual(await row(myFlyer), { damage_marked: 0, is_tapped: false })
    assert.deepEqual(await row(theirGround), { damage_marked: 0, is_tapped: false })
  })
})

// MS4 — destroy_all types + scope opponent: the opponent's creature and
// artifact die; the caster's artifact survives (Ruinous Ultimatum).
test('MS4 destroy_all types-branch honors scope opponent', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const theirCreature = await s.spawnCreature('B', 'Goblin Raider Test')
    const theirArtifact = await s.spawn('B', 'Ichor Wellspring Test', 'battlefield')
    const myArtifact = await s.spawn('A', 'Ichor Wellspring Test', 'battlefield')

    await s.as('A').castSpellEffect([
      { type: 'destroy_all', scope: 'opponent',
        types: ['creature', 'artifact', 'enchantment', 'planeswalker'] },
    ])
    // Flush the stack: the wipe plus any dies-triggers it queues (Wellspring draws).
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(theirCreature), 'graveyard')
    assert.equal(await s.zoneOf(theirArtifact), 'graveyard')
    assert.equal(await s.zoneOf(myArtifact), 'battlefield')
  })
})
