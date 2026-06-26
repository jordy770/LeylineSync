// Carmen, Cruel Skymarcher (mig 341). Two new pieces:
//  • permanent_sacrificed watcher event — "whenever a player sacrifices a
//    permanent, put a +1/+1 counter on Carmen and you gain 1 life." Fired from
//    every sacrifice site (edict, sac-a-creature/self/artifact cost).
//  • return_from_graveyard filter max_mana_value_of:'source_power' + permanent —
//    "whenever Carmen attacks, return up to one target permanent card with mana
//    value <= Carmen's power from your graveyard to the battlefield."

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function resolveAll(s: Scenario) {
  while (await s.topStackItem()) await s.as('A').resolveStack()
}

// CA1 — a sacrifice (here via a sac-a-creature ability) grows Carmen and gains life.
test('CA1 a sacrifice puts a +1/+1 counter on Carmen and gains 1 life', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const carmen = await s.spawnCreature('A', 'Carmen Test')
    const outlet = await s.spawnCreature('A', 'Free Sac Test')
    const fodder = await s.spawnCreature('A', 'Grave Shambler Test')
    await s.spawn('A', 'Air Elemental Test', 'library') // for the draw
    const lifeA = await s.lifeOf('A')

    await s.as('A').activate(outlet, 0, { targetCardId: fodder }) // sac the fodder
    assert.equal(await s.zoneOf(fodder), 'graveyard')
    await resolveAll(s) // the draw + Carmen's sacrifice trigger

    assert.equal((await s.cardState(carmen)).plus_one_counters, 1, 'Carmen grew')
    assert.equal(await s.lifeOf('A'), lifeA + 1, 'gained 1 life')
  })
})

// CA2 — on attack, return a cheap permanent from the graveyard; a permanent whose
// mana value exceeds Carmen's power is not offered.
test('CA2 attack returns a graveyard permanent with mana value <= power', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const carmen = await s.spawnCreature('A', 'Carmen Test') // power 2
    const cheap = await s.spawn('A', 'Vampire Bear Test', 'graveyard') // MV 0
    await s.spawn('A', 'Big Vampire Test', 'graveyard') // MV 5 — too expensive

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(carmen, 'B')
    await s.as('A').resolveStack() // attack trigger → parks the graveyard return pick

    const d = await s.pendingDecision()
    assert.equal(d?.decision_type, 'return_from_graveyard')
    const opts = (d!.options as Array<{ game_card_id: string }>).map((o) => o.game_card_id)
    assert.ok(opts.includes(cheap), 'cheap permanent offered')
    assert.equal(opts.length, 1, 'the MV-5 permanent is NOT offered (power is 2)')

    await s.as('A').submitDecision(d!.id, { chosen: [cheap] })
    assert.equal(await s.zoneOf(cheap), 'battlefield', 'returned to the battlefield')
  })
})
