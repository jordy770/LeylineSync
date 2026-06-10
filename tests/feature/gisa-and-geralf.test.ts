// Gisa and Geralf (mig 207) — "When ~ enters, mill four cards. Once during each
// of your turns, you may cast a Zombie creature spell from your graveyard."
// The permission is a script-registered cast_from_graveyard continuous effect
// (lives while the card is on the battlefield); once_per_turn is stamped in the
// source's counter bag and resets when the turn number changes.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// GG1 — the ETB mills four.
test('GG1 entering mills four cards', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    for (let i = 0; i < 5; i++) await s.spawn('A', 'Air Elemental Test', 'library')

    await s.spawnCreature('A', 'Gisa and Geralf Test')
    await s.as('A').resolveStack()

    assert.equal(await s.zoneCount('A', 'graveyard'), 4)
    assert.equal(await s.zoneCount('A', 'library'), 1)
  })
})

// GG2 — with Gisa and Geralf out, you can cast ONE Zombie from your graveyard
// per turn; the second attempt the same turn is refused; next turn works again.
test('GG2 one Zombie cast from the graveyard per turn', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A', turnNumber: 1 })
    await s.spawnCreature('A', 'Gisa and Geralf Test')
    await s.as('A').resolveStack() // ETB (mills nothing — empty library)
    await s.as('A').rebuild() // registers the permission

    const z1 = await s.spawn('A', 'Grave Shambler Test', 'graveyard')
    const z2 = await s.spawn('A', 'Grave Shambler Test', 'graveyard')

    await s.as('A').castPermanent(z1)
    await s.as('A').resolveStack()
    assert.equal(await s.zoneOf(z1), 'battlefield')

    // Second cast the same turn: the only permission is spent.
    await assert.rejects(
      () => s.as('A').castPermanent(z2),
      /permission to cast that card from your graveyard/i,
    )
  })
})

// GG3 — the limit resets on your next turn.
test('GG3 the once-per-turn limit resets next turn', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A', turnNumber: 1 })
    await s.spawnCreature('A', 'Gisa and Geralf Test')
    await s.as('A').resolveStack()
    await s.as('A').rebuild()

    const z1 = await s.spawn('A', 'Grave Shambler Test', 'graveyard')
    const z2 = await s.spawn('A', 'Grave Shambler Test', 'graveyard')
    await s.as('A').castPermanent(z1)
    await s.as('A').resolveStack()

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A', turnNumber: 2 })
    await s.as('A').castPermanent(z2)
    await s.as('A').resolveStack()
    assert.equal(await s.zoneOf(z2), 'battlefield')
  })
})

// GG4 — the permission is Zombie-only: a non-Zombie stays uncastable.
test('GG4 non-Zombies are not covered', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Gisa and Geralf Test')
    await s.as('A').resolveStack()
    await s.as('A').rebuild()

    const goblin = await s.spawn('A', 'Goblin Raider Test', 'graveyard')
    await assert.rejects(
      () => s.as('A').castPermanent(goblin),
      /permission to cast that card from your graveyard/i,
    )
  })
})
