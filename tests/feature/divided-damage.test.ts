// Phase 3, slice 4a — divided damage (mig 115): the `divided_damage` action type
// deals a total amount split across multiple target creatures/players, as the
// caster allocates. Cast via put_action_on_stack (the client wrapper's path).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// DD1 — 2 damage split 1/1 across two creatures: each takes 1.
test('DD1 divided damage splits across two creatures', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const a = await s.spawnCreature('B', 'Air Elemental Test') // 4/4
    const b = await s.spawnCreature('B', 'Air Elemental Test') // 4/4

    const item = await s.as('A').putOnStack('divided_damage', {
      amount: 2,
      allocations: [
        { target_card_id: a, amount: 1 },
        { target_card_id: b, amount: 1 },
      ],
    })
    await s.as('A').resolveStack()

    assert.equal((await s.cardState(a)).damage_marked, 1)
    assert.equal((await s.cardState(b)).damage_marked, 1)
    assert.equal(await s.stackStatus(item.id), 'resolved')
  })
})

// DD2 — 3 damage split 2 to a creature + 1 to a player.
test('DD2 divided damage splits across a creature and a player', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const cre = await s.spawnCreature('B', 'Air Elemental Test')
    const lifeBefore = await s.lifeOf('B')

    await s.as('A').putOnStack('divided_damage', {
      amount: 3,
      allocations: [
        { target_card_id: cre, amount: 2 },
        { target_player_id: s.playerId('B'), amount: 1 },
      ],
    })
    await s.as('A').resolveStack()

    assert.equal((await s.cardState(cre)).damage_marked, 2)
    assert.equal(await s.lifeOf('B'), lifeBefore - 1)
  })
})

// DD3 — a lethal allocation kills that target; the spell still applies the rest.
test('DD3 divided damage kills a target it deals lethal to', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const viper = await s.spawnCreature('B', 'Deathtouch Viper Test') // 1/1
    const elemental = await s.spawnCreature('B', 'Air Elemental Test') // 4/4

    await s.as('A').putOnStack('divided_damage', {
      amount: 2,
      allocations: [
        { target_card_id: viper, amount: 1 },
        { target_card_id: elemental, amount: 1 },
      ],
    })
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(viper), 'graveyard') // 1 damage is lethal to a 1/1
    assert.equal((await s.cardState(elemental)).damage_marked, 1)
  })
})

// DD4 — the allocations must sum to the total.
test('DD4 divided damage rejects allocations that do not sum to the total', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const a = await s.spawnCreature('B', 'Air Elemental Test')
    const b = await s.spawnCreature('B', 'Air Elemental Test')

    await assert.rejects(
      () =>
        s.as('A').putOnStack('divided_damage', {
          amount: 2,
          allocations: [
            { target_card_id: a, amount: 2 },
            { target_card_id: b, amount: 1 },
          ],
        }),
      /sum to the total/,
    )
  })
})

// DD5 — a target may not receive two allocations.
test('DD5 divided damage rejects a duplicated target', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const a = await s.spawnCreature('B', 'Air Elemental Test')

    await assert.rejects(
      () =>
        s.as('A').putOnStack('divided_damage', {
          amount: 2,
          allocations: [
            { target_card_id: a, amount: 1 },
            { target_card_id: a, amount: 1 },
          ],
        }),
      /more than once/,
    )
  })
})
