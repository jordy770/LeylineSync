// Tier-1 effect vocabulary: all-player life recipients and mass creature effects.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

test('T1 gain_life each_player and lose_life all_players affect both players', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    await s.castSpellEffect([{ type: 'gain_life', amount: 3, recipient: 'each_player' }])
    await s.resolveStack()

    assert.equal(await s.lifeOf('A'), 23)
    assert.equal(await s.lifeOf('B'), 23)

    await s.castSpellEffect([{ type: 'lose_life', amount: 2, recipient: 'all_players' }])
    await s.resolveStack()

    assert.equal(await s.lifeOf('A'), 21)
    assert.equal(await s.lifeOf('B'), 21)
  })
})

test('T1 add_counters_all puts counters only on creatures you control by default', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const a1 = await s.spawnCreature('A', 'Air Elemental Test')
    const a2 = await s.spawnCreature('A', 'Deathtouch Viper Test')
    const b1 = await s.spawnCreature('B', 'Silhana Ledgewalker Test')

    await s.castSpellEffect([{ type: 'add_counters_all', amount: 1 }])
    await s.resolveStack()

    assert.equal((await s.cardState(a1)).plus_one_counters, 1)
    assert.equal((await s.cardState(a2)).plus_one_counters, 1)
    assert.equal((await s.cardState(b1)).plus_one_counters, 0)
  })
})

test('T1 tap_all and untap_all affect creatures you control by default', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const a1 = await s.spawnCreature('A', 'Air Elemental Test')
    const a2 = await s.spawnCreature('A', 'Deathtouch Viper Test')
    const b1 = await s.spawnCreature('B', 'Silhana Ledgewalker Test')

    await s.castSpellEffect([{ type: 'tap_all' }])
    await s.resolveStack()

    assert.equal((await s.cardState(a1)).is_tapped, true)
    assert.equal((await s.cardState(a2)).is_tapped, true)
    assert.equal((await s.cardState(b1)).is_tapped, false)

    await s.castSpellEffect([{ type: 'untap_all' }])
    await s.resolveStack()

    assert.equal((await s.cardState(a1)).is_tapped, false)
    assert.equal((await s.cardState(a2)).is_tapped, false)
    assert.equal((await s.cardState(b1)).is_tapped, false)
  })
})
