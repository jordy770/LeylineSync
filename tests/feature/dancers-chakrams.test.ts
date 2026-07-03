// mig 368 — Dancer's Chakrams: "Equipped creature gets +2/+2, has lifelink and
// 'Other commanders you control get +2/+2 and have lifelink.'" The commander
// clause is a granted ability that only works WHILE a creature is equipped, and
// excludes the equipped creature itself (the "other").

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx, asPlayer } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function setCommander(s: Scenario, cardId: string): Promise<void> {
  await s.client.query('update public.game_cards set is_commander = true where id = $1', [cardId])
}

async function hasLifelink(s: Scenario, seat: 'A' | 'B', cardId: string): Promise<boolean> {
  return asPlayer(s.client, s.playerId(seat), async () => {
    const r = await s.client.query<{ v: boolean }>(
      'select public.card_has_lifelink($1, $2) as v',
      [s.sessionId, cardId],
    )
    return r.rows[0]?.v === true
  })
}

// DC1 — equipping buffs the host AND your other commanders (with lifelink),
// while leaving non-commanders and opponents' commanders alone.
test('DC1 equipped host + other commanders get +2/+2 and lifelink', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const chakrams = await s.spawn('A', 'Dancers Chakrams Test', 'battlefield')
    const host = await s.spawnCreature('A', 'Dino Grunt Test') // 3/3, not a commander
    const myCmdr = await s.spawnCreature('A', 'Air Elemental Test') // 4/4 commander
    await setCommander(s, myCmdr)
    const myDude = await s.spawnCreature('A', 'Goblin Raider Test') // 2/2 non-commander
    const theirCmdr = await s.spawnCreature('B', 'Air Elemental Test') // opponent's commander
    await setCommander(s, theirCmdr)

    await s.setMana('A', { C: 3 })
    await s.as('A').activate(chakrams, 0, { targetCardId: host })

    // Host: 3/3 + 2/2, lifelink.
    assert.equal(await s.effectivePower(host), 5)
    assert.equal(await s.effectiveToughness(host), 5)
    assert.equal(await hasLifelink(s, 'A', host), true)

    // My OTHER commander: 4/4 + 2/2, lifelink.
    assert.equal(await s.effectivePower(myCmdr), 6)
    assert.equal(await s.effectiveToughness(myCmdr), 6)
    assert.equal(await hasLifelink(s, 'A', myCmdr), true)

    // My non-commander creature: untouched by the commander clause.
    assert.equal(await s.effectivePower(myDude), 2)
    assert.equal(await hasLifelink(s, 'A', myDude), false)

    // Opponent's commander: not "you control" → untouched.
    assert.equal(await s.effectivePower(theirCmdr), 4)
    assert.equal(await hasLifelink(s, 'B', theirCmdr), false)
  })
})

// DC2 — the commander clause is a GRANTED ability: with nothing equipped it does
// nothing (this is the "while a creature is equipped" semantics, not until-EOT).
test('DC2 unequipped Chakrams grants nothing to your commanders', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const chakrams = await s.spawn('A', 'Dancers Chakrams Test', 'battlefield')
    const myCmdr = await s.spawnCreature('A', 'Air Elemental Test') // 4/4 commander
    await setCommander(s, myCmdr)
    await s.as('A').rebuild() // register statics; Chakrams is unattached

    assert.equal(await s.effectivePower(myCmdr), 4) // no buff while unequipped
    assert.equal(await hasLifelink(s, 'A', myCmdr), false)
    void chakrams
  })
})

// DC3 — "OTHER commanders": equipping a commander buffs it once (the equipped
// line), not twice — it is excluded from its own commander anthem.
test('DC3 equipping a commander does not double-buff it', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    const chakrams = await s.spawn('A', 'Dancers Chakrams Test', 'battlefield')
    const equippedCmdr = await s.spawnCreature('A', 'Air Elemental Test') // 4/4 commander
    await setCommander(s, equippedCmdr)
    const otherCmdr = await s.spawnCreature('A', 'Dino Grunt Test') // 3/3 commander
    await setCommander(s, otherCmdr)

    await s.setMana('A', { C: 3 })
    await s.as('A').activate(chakrams, 0, { targetCardId: equippedCmdr })

    // Equipped commander: +2/+2 from the equipped line ONLY (excluded from the
    // "other commanders" anthem), so 6/6 not 8/8.
    assert.equal(await s.effectivePower(equippedCmdr), 6)
    assert.equal(await s.effectiveToughness(equippedCmdr), 6)

    // The other commander gets the anthem: 3/3 + 2/2.
    assert.equal(await s.effectivePower(otherCmdr), 5)
    assert.equal(await s.effectiveToughness(otherCmdr), 5)
  })
})
