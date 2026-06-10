// Scourge of Nel Toth (mig 213) — "You may cast this creature from your
// graveyard by paying {B}{B} and sacrificing two creatures rather than paying
// its mana cost." Self-granted alternative graveyard cast: no permission row,
// alternative mana replaces the printed {5}{B}{B}, sacrifices fire dies
// triggers, and the cast counts for the graveyard-cast tracker.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// SN1 — cast from the graveyard for {B}{B} + two chosen sacrifices.
test('SN1 graveyard cast pays the alternative cost', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const scourge = await s.spawn('A', 'Scourge of Nel Toth Test', 'graveyard')
    const fodder1 = await s.spawnCreature('A', 'Goblin Raider Test')
    const fodder2 = await s.spawnCreature('A', 'Grave Shambler Test')
    const keeper = await s.spawnCreature('A', 'Grave Shambler Test')
    await s.setMana('A', { B: 2 }) // ONLY {B}{B} — the printed {5}{B}{B} is unaffordable

    await s.as('A').castPermanent(scourge, { sacrificeIds: [fodder1, fodder2] })
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(scourge), 'battlefield')
    assert.equal(await s.zoneOf(fodder1), 'graveyard')
    assert.equal(await s.zoneOf(fodder2), 'graveyard')
    assert.equal(await s.zoneOf(keeper), 'battlefield') // the chosen set, not auto-pick
  })
})

// SN2 — without two creatures to sacrifice, the cast is refused.
test('SN2 not enough creatures to sacrifice', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const scourge = await s.spawn('A', 'Scourge of Nel Toth Test', 'graveyard')
    await s.spawnCreature('A', 'Goblin Raider Test') // just one
    await s.setMana('A', { B: 2 })

    await assert.rejects(
      () => s.as('A').castPermanent(scourge),
      /creature\(s\) to sacrifice/i,
    )
  })
})
