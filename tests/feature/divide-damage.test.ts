// Divided damage from triggers/abilities (mig 233):
//   • Dragonlord Atarka — ETB: 5 damage divided among opponents' creatures /
//     planeswalkers (a parked divide_damage decision).
//   • Skarrgan Hellkite — Riot ETB (choose +1/+1 counter or haste), then a
//     {3}{R} activated divided-damage ability that may only be used while it has
//     a +1/+1 counter.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// DV1 — Atarka's ETB splits 5 damage across two opposing creatures (3 + 2).
test('DV1 Dragonlord Atarka divides 5 damage among opposing creatures', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const x = await s.spawnCreature('B', 'Air Elemental Test')
    const y = await s.spawnCreature('B', 'Air Elemental Test')

    await s.spawn('A', 'Dragonlord Atarka Test', 'battlefield') // ETB enqueued
    await s.as('A').resolveStack() // ETB → divide_damage parked

    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'divide_damage')
    await s.as('A').submitDecision(d!.id, {
      allocations: [
        { game_card_id: x, amount: 3 },
        { game_card_id: y, amount: 2 },
      ],
    })

    assert.equal((await s.cardState(x)).damage_marked, 3)
    assert.equal((await s.cardState(y)).damage_marked, 2)
  })
})

// DV2 — an allocation that doesn't total the amount is rejected.
test('DV2 Atarka rejects an allocation that does not total 5', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const x = await s.spawnCreature('B', 'Air Elemental Test')

    await s.spawn('A', 'Dragonlord Atarka Test', 'battlefield')
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()

    await assert.rejects(
      () => s.as('A').submitDecision(d!.id, { allocations: [{ game_card_id: x, amount: 4 }] }),
      /total 5/i)
  })
})

// DV3 — Skarrgan: Riot (+1/+1 counter), then activate the divided-damage ability.
test('DV3 Skarrgan riots a counter, then activates divided damage', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const skarrgan = await s.spawn('A', 'Skarrgan Hellkite Test', 'battlefield') // Riot ETB
    const target = await s.spawnCreature('B', 'Air Elemental Test')

    await s.as('A').resolveStack() // Riot choose_one parked
    const riot = await s.pendingDecision()
    await s.as('A').submitDecision(riot!.id, { chosen: [0] }) // +1/+1 counter
    assert.equal((await s.cardState(skarrgan)).plus_one_counters, 1)

    await s.setMana('A', { C: 3, R: 1 }) // {3}{R}
    await s.as('A').activate(skarrgan, 0)
    await s.as('A').resolveStack() // divide_damage parked
    const dd = await s.pendingDecision()
    assert.equal(dd!.decision_type, 'divide_damage')
    await s.as('A').submitDecision(dd!.id, { allocations: [{ game_card_id: target, amount: 2 }] })

    assert.equal((await s.cardState(target)).damage_marked, 2)
  })
})

// DV4 — Skarrgan's ability can't be activated when it chose haste (no counter).
test('DV4 Skarrgan cannot activate divided damage without a +1/+1 counter', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const skarrgan = await s.spawn('A', 'Skarrgan Hellkite Test', 'battlefield')

    await s.as('A').resolveStack()
    const riot = await s.pendingDecision()
    await s.as('A').submitDecision(riot!.id, { chosen: [1] }) // haste — no counter

    await s.setMana('A', { C: 3, R: 1 })
    await assert.rejects(() => s.as('A').activate(skarrgan, 0), /cannot be activated/i)
  })
})
