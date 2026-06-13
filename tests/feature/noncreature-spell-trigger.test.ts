// Noncreature-spell watcher (mig 292): a spell_cast triggered ability with
// `filter.exclude_type: 'Creature'` fires when you cast a NONCREATURE spell and
// stays silent on a creature cast — the magecraft/spellcraft payoff pattern the
// Scions Spellcraft deck is built around (Y'shtola, Archmage Emeritus, …).
//
// Magecraft Tester Test: "Whenever you cast a noncreature spell, you gain 2 life."

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// NC1 — casting a noncreature spell (a Sorcery) fires the magecraft trigger.
test('NC1 magecraft fires when you cast a noncreature spell', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawnCreature('A', 'Magecraft Tester Test')
    const spark = await s.spawn('A', 'Spellcraft Spark Test', 'hand') // Sorcery {R}

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { R: 1 })
    const start = await s.lifeOf('A')

    await s.as('A').castSpellEffect([{ type: 'draw', amount: 1, recipient: 'controller' }], spark)
    await s.as('A').resolveStack()

    assert.equal(await s.lifeOf('A'), start + 2)
  })
})

// NC2 — casting a CREATURE spell must NOT fire it (exclude_type matches).
test('NC2 magecraft stays silent when you cast a creature spell', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawnCreature('A', 'Magecraft Tester Test')
    const creature = await s.spawn('A', 'Red Wall Test', 'hand') // Creature {R}

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { R: 1 })
    const start = await s.lifeOf('A')

    await s.as('A').castPermanent(creature)
    await s.as('A').resolveStack()

    assert.equal(await s.lifeOf('A'), start)
  })
})

// NC3 — mana-value gate (mig 293): a MV-3 noncreature spell fires the gated
// magecraft; a MV-1 one does not.
test('NC3 min_mana_value gates the magecraft trigger', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawnCreature('A', 'Mana Value Magecraft Test') // fires only on MV >= 3
    const cheap = await s.spawn('A', 'Spellcraft Spark Test', 'hand') // Sorcery {R} (MV 1)
    const big = await s.spawn('A', 'Spellcraft Bolt Test', 'hand') // Sorcery {2}{R} (MV 3)

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { R: 4 })
    const start = await s.lifeOf('A')

    // MV 1 — below the threshold, no life gain.
    await s.as('A').castSpellEffect([{ type: 'draw', amount: 1, recipient: 'controller' }], cheap)
    await s.as('A').resolveStack()
    assert.equal(await s.lifeOf('A'), start)

    // MV 3 — fires, +2 life.
    await s.as('A').castSpellEffect([{ type: 'draw', amount: 1, recipient: 'controller' }], big)
    await s.as('A').resolveStack()
    assert.equal(await s.lifeOf('A'), start + 2)
  })
})
