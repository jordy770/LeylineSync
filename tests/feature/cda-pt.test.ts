// Phase 4 / F2.2f — characteristic-defining P/T, layer 7a (mig 149). A CDA defines
// the base P/T from a game count ("*/* = creatures you control"), applied before
// counters/pumps and overridable by a 7b set. Wild Tracker Test is */* = creatures
// you control (counts itself).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// CD1 — alone, the CDA creature counts itself: 1/1.
test('CD1 a CDA creature defines its P/T from the count', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const wt = await s.spawnCreature('A', 'Wild Tracker Test')

    assert.equal(await s.effectivePower(wt), 1)
    assert.equal(await s.effectiveToughness(wt), 1)
  })
})

// CD2 — the CDA recomputes live as more creatures join the board.
test('CD2 the CDA grows with the board', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const wt = await s.spawnCreature('A', 'Wild Tracker Test')
    await s.spawnCreature('A', 'Goblin Raider Test')
    await s.spawnCreature('A', 'Goblin Raider Test')

    assert.equal(await s.effectivePower(wt), 3) // itself + 2
    assert.equal(await s.effectiveToughness(wt), 3)
  })
})

// CD3 — "creatures YOU control": an opponent's creatures don't count.
test('CD3 the CDA is controller-scoped', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const wt = await s.spawnCreature('A', 'Wild Tracker Test')
    await s.spawnCreature('B', 'Goblin Raider Test')
    await s.spawnCreature('B', 'Goblin Raider Test')

    assert.equal(await s.effectivePower(wt), 1) // only A's lone creature (itself)
  })
})

// CD4 — a 7b set overrides the 7a CDA ("becomes 0/1" beats */*).
test('CD4 a set_pt overrides the CDA', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const wt = await s.spawnCreature('A', 'Wild Tracker Test')
    await s.spawnCreature('A', 'Goblin Raider Test') // CDA would be 2/2
    await s.setBasePT(wt, 0, 1) // becomes 0/1

    assert.equal(await s.effectivePower(wt), 0)
    assert.equal(await s.effectiveToughness(wt), 1)
  })
})

// CD5 — counters (7c) stack on top of the CDA base.
test('CD5 counters add on top of the CDA', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const wt = await s.spawnCreature('A', 'Wild Tracker Test') // 1/1 alone
    await s.putOnStack('add_counters_creature', { target_card_id: wt, amount: 1 })
    await s.resolveStack()

    assert.equal(await s.effectivePower(wt), 2) // 1 (CDA) + 1 (counter)
    assert.equal(await s.effectiveToughness(wt), 2)
  })
})
