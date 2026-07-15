// mig 406 — death replacement (Kalitas, Traitor of Ghet): "Whenever a nontoken
// creature an opponent controls would die, exile it instead. If you do, create
// a 2/2 black Zombie." A dies_replacement continuous effect intercepts the
// death at put_in_graveyard (THE chokepoint — combat SBA, destroy, sacrifice
// and dies all funnel through it), so the creature is exiled, never dies, and
// the replacement's controller gets a Zombie.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx, asPlayer } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function zombies(s: Scenario, seat: 'A' | 'B'): Promise<number> {
  const r = await s.client.query(
    `select count(*)::int as n from public.game_cards gc join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.controller_player_id = $2 and gc.zone = 'battlefield' and c.name = 'Zombie Token'`,
    [s.sessionId, s.players[seat]])
  return r.rows[0].n
}

// DR1 — an opponent's nontoken creature is exiled instead of dying, and Kalitas'
// controller gets a Zombie.
test('DR1 opponent creature is exiled instead of dying; controller makes a Zombie', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Kalitas Test')
    const victim = await s.spawnCreature('B', 'Air Elemental Test') // nontoken, opponent

    await asPlayer(s.client, s.players.A, () => s.client.query(
      `select public.apply_creature_effect($1, 'destroy', $2, '{}'::jsonb)`,
      [s.sessionId, victim]))

    assert.equal(await s.zoneOf(victim), 'exile') // exiled, not graveyard
    assert.equal(await zombies(s, 'A'), 1) // Kalitas' controller made a Zombie
    assert.equal(await zombies(s, 'B'), 0)
  })
})

// DR2 — YOUR OWN creature dying is not replaced (scope is opponents only).
test('DR2 your own creature still dies normally', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Kalitas Test')
    const mine = await s.spawnCreature('A', 'Air Elemental Test')

    await asPlayer(s.client, s.players.A, () => s.client.query(
      `select public.apply_creature_effect($1, 'destroy', $2, '{}'::jsonb)`,
      [s.sessionId, mine]))

    assert.equal(await s.zoneOf(mine), 'graveyard') // not exiled
    assert.equal(await zombies(s, 'A'), 0) // no replacement fired
  })
})

// DR3 — a TOKEN an opponent controls is not replaced (nontoken filter); it just
// ceases, and no Zombie is made.
test('DR3 an opponent token is not replaced (nontoken filter)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Kalitas Test')
    const token = await s.spawn('B', 'Zombie Token', 'battlefield') // opponent's token

    await asPlayer(s.client, s.players.A, () => s.client.query(
      `select public.apply_creature_effect($1, 'destroy', $2, '{}'::jsonb)`,
      [s.sessionId, token]))

    assert.notEqual(await s.zoneOf(token), 'exile') // ceased/graveyard, not exiled by Kalitas
    assert.equal(await zombies(s, 'A'), 0) // replacement did NOT fire for a token
  })
})
