// Ardbert, Warrior of Darkness (mig 299): casting a white/black spell puts a
// +1/+1 counter on each LEGENDARY creature you control (add_counters_all
// type_line:'Legendary') and grants them a keyword until end of turn. The
// spell_color watcher filter gates which casts fire.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// ARD1 — a white spell buffs your legendaries; non-legendaries are untouched.
test('ARD1 casting a white spell adds +1/+1 to each legendary you control', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawnCreature('A', 'Ardbert Test')
    const legend = await s.spawnCreature('A', 'Legend Bear Test')       // 2/2 legendary
    const plain = await s.spawnCreature('A', 'Air Elemental Test')      // 4/4 non-legendary
    const spark = await s.spawn('A', 'White Spark Test', 'hand')        // {W}

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { W: 1 })

    await s.as('A').castSpellEffect([{ type: 'draw', amount: 1, recipient: 'controller' }], spark)
    await s.as('A').resolveStack()

    assert.equal(await s.effectivePower(legend), 3) // 2/2 + 1 (legendary)
    assert.equal(await s.effectivePower(plain), 4)  // unchanged (not legendary)
  })
})

// ARD2 — a red spell does not fire either trigger.
test('ARD2 a red spell does not buff legendaries', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawnCreature('A', 'Ardbert Test')
    const legend = await s.spawnCreature('A', 'Legend Bear Test')
    const spark = await s.spawn('A', 'Spellcraft Spark Test', 'hand')   // {R}

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { R: 1 })

    await s.as('A').castSpellEffect([{ type: 'draw', amount: 1, recipient: 'controller' }], spark)
    await s.as('A').resolveStack()

    assert.equal(await s.effectivePower(legend), 2) // unchanged
  })
})
