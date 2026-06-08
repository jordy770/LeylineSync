// Liliana, Untouched by Death — her +1 (conditional mill). "Mill three cards. If at
// least one Zombie card is milled this way, each opponent loses 2 life and you gain 2."
// Exercises the planeswalker loyalty framework + the conditional-mill feature.
// Also covers her -2 (loyalty targeting + dynamic pump) and -3 (cast-from-graveyard).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function loyalty(s: Scenario, card: string): Promise<number> {
  const r = await s.client.query<{ l: string | null }>(
    "select (counters ->> 'loyalty') as l from public.game_cards where id = $1", [card],
  )
  return r.rows[0]?.l == null ? 0 : Number(r.rows[0]!.l)
}

// LIL1 — milling a Zombie triggers the drain (B loses 2, A gains 2); loyalty 4→5.
test('LIL1 +1 drains when a Zombie is milled', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const lil = await s.spawn('A', 'Liliana, Untouched by Death', 'battlefield')
    await s.spawn('A', 'Grave Shambler Test', 'library') // a Zombie in the top 3
    await s.spawn('A', 'Air Elemental Test', 'library')
    await s.spawn('A', 'Air Elemental Test', 'library')
    const aBefore = await s.lifeOf('A')
    const bBefore = await s.lifeOf('B')

    await s.as('A').activateLoyalty(lil, 0)
    await s.as('A').resolveStack()

    assert.equal(await loyalty(s, lil), 5)
    assert.equal(await s.lifeOf('B'), bBefore - 2)
    assert.equal(await s.lifeOf('A'), aBefore + 2)
  })
})

// LIL3 — her -2: target creature gets -X/-X where X = Zombies you control.
test('LIL3 -2 debuffs a target by your Zombie count', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const lil = await s.spawn('A', 'Liliana, Untouched by Death', 'battlefield')
    await s.spawnCreature('A', 'Grave Shambler Test') // Zombie
    await s.spawnCreature('A', 'Grave Shambler Test') // Zombie → X = 2
    const victim = await s.spawnCreature('B', 'Air Elemental Test') // 4/4

    await s.as('A').activateLoyalty(lil, 1) // -2 (targeted)
    const trig = await s.topStackItem()
    await s.as('A').chooseTriggerTarget(trig!.id, victim)
    await s.as('A').resolveStack()

    assert.equal(await loyalty(s, lil), 2) // 4 − 2
    assert.equal(await s.effectivePower(victim), 2) // 4 − 2
    assert.equal(await s.effectiveToughness(victim), 2) // 4 − 2
  })
})

// LIL4 — a lethal -X/-X (toughness to 0) sends the creature to the graveyard.
test('LIL4 -2 can be lethal', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const lil = await s.spawn('A', 'Liliana, Untouched by Death', 'battlefield')
    await s.spawnCreature('A', 'Grave Shambler Test')
    await s.spawnCreature('A', 'Grave Shambler Test') // X = 2
    const victim = await s.spawnCreature('B', 'Grave Shambler Test') // a 2/2

    await s.as('A').activateLoyalty(lil, 1)
    const trig = await s.topStackItem()
    await s.as('A').chooseTriggerTarget(trig!.id, victim)
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(victim), 'graveyard') // 2/2 − 2/2 = 0 toughness → dies
  })
})

// LIL5 — her -3: grants casting Zombie cards from the graveyard this turn.
test('LIL5 -3 lets you cast a Zombie from the graveyard', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const lil = await s.spawn('A', 'Liliana, Untouched by Death', 'battlefield')
    const zombie = await s.spawn('A', 'Grave Shambler Test', 'graveyard') // a Zombie 2/2
    const elemental = await s.spawn('A', 'Air Elemental Test', 'graveyard') // not a Zombie

    // Before the -3, casting from the graveyard is rejected. The raising RPC aborts
    // the tx; a savepoint lets the test continue afterwards.
    await s.client.query('savepoint lil5a')
    await assert.rejects(() => s.as('A').castPermanent(zombie), /permission/)
    await s.client.query('rollback to savepoint lil5a')

    await s.as('A').activateLoyalty(lil, 2) // -3
    await s.as('A').resolveStack()
    assert.equal(await loyalty(s, lil), 1) // 4 − 3

    // Now the Zombie can be cast from the graveyard; a non-Zombie still cannot.
    await s.client.query('savepoint lil5b')
    await assert.rejects(() => s.as('A').castPermanent(elemental), /permission/)
    await s.client.query('rollback to savepoint lil5b')
    await s.as('A').castPermanent(zombie)
    assert.equal(await s.zoneOf(zombie), 'stack')
    await s.as('A').resolveStack()
    assert.equal(await s.zoneOf(zombie), 'battlefield')
  })
})

// LIL2 — milling no Zombies does NOT drain.
test('LIL2 +1 does not drain without a Zombie milled', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const lil = await s.spawn('A', 'Liliana, Untouched by Death', 'battlefield')
    await s.spawn('A', 'Air Elemental Test', 'library')
    await s.spawn('A', 'Air Elemental Test', 'library')
    await s.spawn('A', 'Air Elemental Test', 'library')
    const bBefore = await s.lifeOf('B')

    await s.as('A').activateLoyalty(lil, 0)
    await s.as('A').resolveStack()

    assert.equal(await loyalty(s, lil), 5)
    assert.equal(await s.lifeOf('B'), bBefore) // no Zombie milled → no drain
    assert.equal(await s.zoneCount('A', 'graveyard'), 3) // still milled 3
  })
})
