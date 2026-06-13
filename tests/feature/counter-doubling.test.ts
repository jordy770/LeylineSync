// Counter doubling — Doubling Season (roadmap Counters #5, half 1). A static
// `doubles_counters: true` permanent makes every counter PLACED on a permanent its
// controller controls land twice (two stack to ×4). Removal isn't doubled. The rule
// keys off the recipient's controller, so it covers targeted spells, the source's own
// add_counters, mass add_counters_all (per recipient), and enters-with-counters.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// DS1 — a Doubling Season controller's targeted +1/+1 counter is doubled.
test('DS1 Doubling Season doubles a targeted +1/+1 counter', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Doubling Season Test', 'battlefield')
    const bear = await s.spawnCreature('A', 'Air Elemental Test') // 4/4

    await s.as('A').castSpellEffect([{ type: 'add_counters', amount: 1 }], bear)
    await s.as('A').resolveStack()

    assert.equal((await s.cardState(bear)).plus_one_counters, 2)
  })
})

// DS2 — a permanent ENTERS with twice the counters under a Doubling Season.
test('DS2 Doubling Season doubles enters-with counters', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Doubling Season Test', 'battlefield')
    const walker = await s.spawnCreature('A', 'Counter Walker Test') // 0/0, enters with 2

    assert.equal((await s.cardState(walker)).plus_one_counters, 4)
    assert.equal(await s.zoneOf(walker), 'battlefield') // 4/4, survives
  })
})

// DS3 — two Doubling Seasons stack multiplicatively (×4).
test('DS3 two Doubling Seasons quadruple a counter', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Doubling Season Test', 'battlefield')
    await s.spawn('A', 'Doubling Season Test', 'battlefield')
    const bear = await s.spawnCreature('A', 'Air Elemental Test')

    await s.as('A').castSpellEffect([{ type: 'add_counters', amount: 1 }], bear)
    await s.as('A').resolveStack()

    assert.equal((await s.cardState(bear)).plus_one_counters, 4)
  })
})

// DS4 — removal is NOT doubled (Doubling Season only doubles counters put ON).
test('DS4 Doubling Season does not double counter removal', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Doubling Season Test', 'battlefield')
    const bear = await s.spawnCreature('A', 'Air Elemental Test')

    await s.as('A').castSpellEffect([{ type: 'add_counters', amount: 1 }], bear) // → 2
    await s.as('A').resolveStack()
    await s.as('A').castSpellEffect([{ type: 'add_counters', amount: -1 }], bear) // remove 1, not doubled
    await s.as('A').resolveStack()

    assert.equal((await s.cardState(bear)).plus_one_counters, 1)
  })
})

// DS5 — a mass add_counters_all doubles per RECIPIENT's controller, not the caster's.
test('DS5 mass counters double per recipient controller', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Doubling Season Test', 'battlefield') // only A has the doubler
    const a1 = await s.spawnCreature('A', 'Air Elemental Test')
    const b1 = await s.spawnCreature('B', 'Air Elemental Test')

    await s.as('A').castSpellEffect([{ type: 'add_counters_all', amount: 1, target_controller: 'any' }])
    await s.as('A').resolveStack()

    assert.equal((await s.cardState(a1)).plus_one_counters, 2) // A's creature doubled
    assert.equal((await s.cardState(b1)).plus_one_counters, 1) // B's creature not doubled
  })
})
