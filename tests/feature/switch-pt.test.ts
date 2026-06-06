// Phase 4 / F2.2e — P/T SWITCH, the last layer sublayer (mig 146, CR 613.7e). A
// switch_pt effect swaps the fully-layered power and toughness; an even number of
// switches cancels. Tests use add_switch_pt_effect (+ setBasePT / counters) directly,
// mirroring the set_pt layer tests (L1-4).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// SW1 — a switch swaps the printed base P/T (set to an asymmetric 1/4).
test('SW1 switch swaps power and toughness', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const c = await s.spawnCreature('A', 'Goblin Raider Test')
    await s.setBasePT(c, 1, 4)
    await s.addSwitchPt(c)

    assert.equal(await s.effectivePower(c), 4)
    assert.equal(await s.effectiveToughness(c), 1)
  })
})

// SW2 — the switch is LAST: a +1/+1 counter applies first (1/4 -> 2/5), then swaps.
test('SW2 switch applies after counters', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const c = await s.spawnCreature('A', 'Goblin Raider Test')
    await s.setBasePT(c, 1, 4) // 1/4
    await s.putOnStack('add_counters_creature', { target_card_id: c, amount: 1 })
    await s.resolveStack() // 2/5
    await s.addSwitchPt(c)

    assert.equal(await s.effectivePower(c), 5)
    assert.equal(await s.effectiveToughness(c), 2)
  })
})

// SW3 — two switches cancel (parity): back to the unswitched P/T.
test('SW3 two switches cancel out', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const c = await s.spawnCreature('A', 'Goblin Raider Test')
    await s.setBasePT(c, 1, 4)
    await s.addSwitchPt(c)
    await s.addSwitchPt(c)

    assert.equal(await s.effectivePower(c), 1)
    assert.equal(await s.effectiveToughness(c), 4)
  })
})

// SW4 — switch composes with set_pt ("becomes 0/1" then switched -> 1/0).
test('SW4 switch composes with a set_pt', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const c = await s.spawnCreature('A', 'Goblin Raider Test') // 2/2
    await s.setBasePT(c, 0, 1) // becomes 0/1
    await s.addSwitchPt(c)

    assert.equal(await s.effectivePower(c), 1)
    assert.equal(await s.effectiveToughness(c), 0)
  })
})
