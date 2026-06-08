// Choose a creature type (roadmap Tribal #6). A choose_creature_type effect parks a
// type-choice decision; on submit the chosen type is injected into any count-based
// amount's type_line — Distant Melody draws a card for each creature of that type.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

const MELODY = [{ type: 'choose_creature_type', effects: [{ type: 'draw', amount: { count: 'creatures_you_control' } }] }]

// CCT1 — Distant Melody: choosing Zombie draws a card per Zombie you control.
test('CCT1 chosen type drives the count', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Grave Shambler Test') // Zombie
    await s.spawnCreature('A', 'Grave Shambler Test') // Zombie
    await s.spawnCreature('A', 'Goblin Raider Test') // not a Zombie
    for (let i = 0; i < 3; i++) await s.spawn('A', 'Air Elemental Test', 'library')
    const handBefore = await s.zoneCount('A', 'hand')

    await s.as('A').castSpellEffect(MELODY)
    await s.as('A').resolveStack() // parks the choose_creature_type decision
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { type: 'Zombie' })

    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 2) // 2 Zombies
  })
})

// CCT2 — choosing a different type counts only that type (1 Goblin → draw 1).
test('CCT2 the chosen type is what gets counted', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Grave Shambler Test') // Zombie
    await s.spawnCreature('A', 'Grave Shambler Test') // Zombie
    await s.spawnCreature('A', 'Goblin Raider Test') // 1 Goblin
    for (let i = 0; i < 3; i++) await s.spawn('A', 'Air Elemental Test', 'library')
    const handBefore = await s.zoneCount('A', 'hand')

    await s.as('A').castSpellEffect(MELODY)
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { type: 'Goblin' }) // only the 1 Goblin counts

    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 1)
  })
})
