// Death Baron (mig 200) — "Skeletons you control and other Zombies you control
// get +1/+1 and have deathtouch." Composed from typed-lord pumps (mig 164) +
// typed keyword grants (mig 184); mig 200 adds the exclude_source payload filter
// to the keyword accessors so the "other Zombies" deathtouch half skips the Baron
// himself (the pump fold already honoured it).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx, asPlayer } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function hasDeathtouch(s: Scenario, seat: 'A' | 'B', cardId: string): Promise<boolean> {
  return asPlayer(s.client, s.players[seat], async () => {
    const r = await s.client.query<{ r: boolean }>(
      'select public.card_has_deathtouch($1, $2) as r',
      [s.sessionId, cardId],
    )
    return r.rows[0]!.r
  })
}

async function pt(s: Scenario, card: string): Promise<{ p: number; t: number }> {
  return { p: await s.effectivePower(card), t: await s.effectiveToughness(card) }
}

// DB1 — both halves: Skeletons (inclusive) + OTHER Zombies get +1/+1 and deathtouch.
test('DB1 Death Baron buffs Skeletons and other Zombies, not himself', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const baron = await s.spawnCreature('A', 'Death Baron Test') // 2/2 Zombie Wizard
    const skeleton = await s.spawnCreature('A', 'Skeleton Warrior Test') // 1/1 Skeleton
    const zombie = await s.spawnCreature('A', 'Grave Shambler Test') // 2/2 Zombie
    const goblin = await s.spawnCreature('A', 'Goblin Raider Test') // 2/2 non-tribal
    const theirZombie = await s.spawnCreature('B', 'Grave Shambler Test')
    await s.as('A').rebuild()

    assert.deepEqual(await pt(s, skeleton), { p: 2, t: 2 }) // +1/+1
    assert.deepEqual(await pt(s, zombie), { p: 3, t: 3 }) // +1/+1
    assert.deepEqual(await pt(s, baron), { p: 2, t: 2 }) // "other Zombies" — not himself
    assert.deepEqual(await pt(s, goblin), { p: 2, t: 2 }) // wrong type
    assert.deepEqual(await pt(s, theirZombie), { p: 2, t: 2 }) // opponent's

    assert.equal(await hasDeathtouch(s, 'A', skeleton), true)
    assert.equal(await hasDeathtouch(s, 'A', zombie), true)
    assert.equal(await hasDeathtouch(s, 'A', baron), false) // exclude_source on the Zombie grant
    assert.equal(await hasDeathtouch(s, 'A', goblin), false)
    assert.equal(await hasDeathtouch(s, 'B', theirZombie), false)
  })
})

// DB2 — a second Zombie lord IS another Zombie: two Barons grant each other
// deathtouch (each is "another Zombie" to the other) but never themselves alone.
test('DB2 two Death Barons cover each other', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const baron1 = await s.spawnCreature('A', 'Death Baron Test')
    const baron2 = await s.spawnCreature('A', 'Death Baron Test')
    await s.as('A').rebuild()

    assert.equal(await hasDeathtouch(s, 'A', baron1), true) // granted by baron2
    assert.equal(await hasDeathtouch(s, 'A', baron2), true) // granted by baron1
    assert.deepEqual(await pt(s, baron1), { p: 3, t: 3 }) // +1/+1 from the OTHER baron
  })
})
