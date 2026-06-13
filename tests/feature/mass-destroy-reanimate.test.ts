// Mass destroy + mass reanimate (mig 185). Zombie Apocalypse: "Return all Zombie
// creature cards from your graveyard to the battlefield. Destroy all Humans."

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

const ZA_ACTIONS = [
  { type: 'return_all_from_graveyard', creature_type: 'Zombie', to: 'battlefield' },
  { type: 'destroy_all', creature_type: 'Human', scope: 'all' },
]

// ZA1 — return all graveyard Zombies; destroy all Humans (any controller); other
// creatures untouched.
test('ZA1 Zombie Apocalypse reanimates Zombies and wipes Humans', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const gz1 = await s.spawn('A', 'Grave Shambler Test', 'graveyard') // Zombie in graveyard
    const gz2 = await s.spawn('A', 'Grave Shambler Test', 'graveyard')
    const myHuman = await s.spawnCreature('A', 'Prodigal Sorcerer Test') // Human
    const theirHuman = await s.spawnCreature('B', 'Prodigal Sorcerer Test') // opponent's Human
    const myZombie = await s.spawnCreature('A', 'Grave Shambler Test') // a Zombie (survives)

    await s.as('A').castSpellEffect(ZA_ACTIONS)
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(gz1), 'battlefield') // reanimated
    assert.equal(await s.zoneOf(gz2), 'battlefield')
    assert.equal(await s.zoneOf(myHuman), 'graveyard') // wiped
    assert.equal(await s.zoneOf(theirHuman), 'graveyard') // wiped (any controller)
    assert.equal(await s.zoneOf(myZombie), 'battlefield') // a Zombie → untouched
  })
})

// ZA2 — scope 'you' destroys only your creatures; an untyped wipe hits everything.
test('ZA2 destroy_all respects scope and type', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const mine = await s.spawnCreature('A', 'Grave Shambler Test')
    const theirs = await s.spawnCreature('B', 'Grave Shambler Test')

    await s.as('A').castSpellEffect([{ type: 'destroy_all', scope: 'you' }])
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(mine), 'graveyard') // yours destroyed
    assert.equal(await s.zoneOf(theirs), 'battlefield') // opponent's spared
  })
})
