// Liliana's Mastery — "Zombies you control get +1/+1. When Liliana's Mastery enters
// the battlefield, create two 2/2 black Zombie creature tokens." A free composition of
// two already-supported pieces: a typed static anthem (a `pump` continuous effect,
// affected:'controller', payload.creature_type 'Zombie' — see typed-lords) and an
// `enters_the_battlefield` triggered ability with `create_token` count 2 (see Army of
// the Damned / Saproling Marshal). Spawning the enchantment to the battlefield fires its
// ETB zone-change trigger; the anthem registers on rebuild.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// Count a seat's battlefield 'Zombie Token's (the 2/2 black Zombie the ETB makes).
async function zombieTokens(s: Scenario, seat: 'A' | 'B'): Promise<number> {
  const res = await s.client.query<{ n: string }>(
    `select count(*) as n from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.controller_player_id = $2
       and gc.zone = 'battlefield' and c.name = 'Zombie Token'`,
    [s.sessionId, s.players[seat]],
  )
  return Number(res.rows[0]?.n ?? 0)
}

// LM1 — the ETB trigger creates two Zombie tokens.
test('LM1 entering creates two 2/2 Zombie tokens', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    await s.spawn('A', "Liliana's Mastery Test", 'battlefield') // ETB: create two Zombie Tokens
    await s.as('A').resolveStack()

    assert.equal(await zombieTokens(s, 'A'), 2)
  })
})

// LM2 — the anthem buffs your Zombies (+1/+1) but not a non-Zombie or an opponent's
// Zombie (affected:'controller' + creature_type filter).
test('LM2 your Zombies get +1/+1; non-Zombies and opponents are unaffected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawn('A', "Liliana's Mastery Test", 'battlefield') // the Zombie anthem
    const myZombie = await s.spawnCreature('A', 'Grave Shambler Test') // 2/2 Zombie
    const myGoblin = await s.spawnCreature('A', 'Goblin Raider Test') // 2/2 non-Zombie
    const theirZombie = await s.spawnCreature('B', 'Grave Shambler Test') // 2/2 Zombie, opponent
    await s.as('A').resolveStack() // clear the ETB token trigger
    await s.as('A').rebuild()

    assert.equal(await s.effectivePower(myZombie), 3) // 2/2 -> 3/3
    assert.equal(await s.effectiveToughness(myZombie), 3)
    assert.equal(await s.effectivePower(myGoblin), 2) // wrong type — unbuffed
    assert.equal(await s.effectiveToughness(myGoblin), 2)
    assert.equal(await s.effectivePower(theirZombie), 2) // controller anthem — not opponents
    assert.equal(await s.effectiveToughness(theirZombie), 2)
  })
})
