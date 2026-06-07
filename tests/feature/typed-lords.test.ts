// Typed lords / tribal anthems (roadmap Tribal #1, first slice). A `pump` continuous
// effect (affected:'controller') with payload.creature_type buffs only that subtype,
// and payload.exclude_source:true makes "OTHER Zombies" skip the lord itself. Folded
// into the mass-pump term of card_layered_power/toughness.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function pt(s: Scenario, card: string): Promise<{ p: number; t: number }> {
  return { p: await s.effectivePower(card), t: await s.effectiveToughness(card) }
}

// TL1 — "Other Zombies you control get +1/+1": buffs your other Zombies only — not
// non-Zombies, not the lord itself, not an opponent's Zombie.
test('TL1 a typed "other" lord buffs only your other Zombies', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const lord = await s.spawnCreature('A', 'Zombie Lord Test') // 2/2 Zombie, "other Zombies +1/+1"
    const myZombie = await s.spawnCreature('A', 'Grave Shambler Test') // 2/2 Zombie
    const myGoblin = await s.spawnCreature('A', 'Goblin Raider Test') // 2/2 non-Zombie
    const theirZombie = await s.spawnCreature('B', 'Grave Shambler Test') // 2/2 Zombie, opponent
    await s.as('A').rebuild()

    assert.deepEqual(await pt(s, myZombie), { p: 3, t: 3 }) // buffed
    assert.deepEqual(await pt(s, myGoblin), { p: 2, t: 2 }) // wrong type
    assert.deepEqual(await pt(s, lord), { p: 2, t: 2 }) // exclude_source — not itself
    assert.deepEqual(await pt(s, theirZombie), { p: 2, t: 2 }) // controller anthem — not opponents
  })
})

// TL2 — an inclusive typed lord (no exclude_source) buffs itself too.
test('TL2 an inclusive typed lord buffs itself', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const king = await s.spawnCreature('A', 'Zombie King Test') // 2/2 Zombie, "Zombies +1/+1"
    const other = await s.spawnCreature('A', 'Grave Shambler Test')
    await s.as('A').rebuild()

    assert.deepEqual(await pt(s, king), { p: 3, t: 3 }) // includes itself
    assert.deepEqual(await pt(s, other), { p: 3, t: 3 })
  })
})

// TL3 — two typed lords stack on a shared Zombie (and on each other, minus self).
test('TL3 typed lords stack', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const lord = await s.spawnCreature('A', 'Zombie Lord Test') // "other" lord
    const king = await s.spawnCreature('A', 'Zombie King Test') // inclusive lord
    const z = await s.spawnCreature('A', 'Grave Shambler Test')
    await s.as('A').rebuild()

    assert.deepEqual(await pt(s, z), { p: 4, t: 4 }) // +1 from each lord
    // lord: +1 from king (inclusive), +0 from itself (exclude_source) = 3/3
    assert.deepEqual(await pt(s, lord), { p: 3, t: 3 })
    // king: +1 from lord ("other"), +1 from itself (inclusive) = 4/4
    assert.deepEqual(await pt(s, king), { p: 4, t: 4 })
  })
})
