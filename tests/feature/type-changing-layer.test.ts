// mig 407 — the type-changing layer: a granted_type continuous effect adds (or
// overrides) a permanent's types, and effective_type_line folds them so type
// checks see them. Multiversal Passage chooses a basic land type as it enters
// (registering a granted_type + baking the matching mana ability); and a
// granted type is visible to tribal watchers via fire_watcher_triggers.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function effType(s: Scenario, id: string): Promise<string> {
  const r = await s.client.query('select public.effective_type_line($1, $2) as t', [s.sessionId, id])
  return r.rows[0].t
}

// TC1 — Multiversal Passage: choosing Island makes it an Island that taps for U.
test('TC1 Multiversal Passage becomes the chosen basic type and taps for its mana', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const passage = await s.spawn('A', 'Multiversal Passage Test', 'battlefield')

    // Resolve the ETB trigger; it parks the basic-land-type pick.
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()
    const d = (await s.pendingDecision()) as { id: string }
    assert.ok(d, 'choose_land_type parked')
    await s.as('A').submitDecision(d.id, { type: 'Island' })

    // It IS an Island now, and taps for U.
    assert.match(await effType(s, passage), /Island/)
    const pool = await s.as('A').activateMana(passage, 0)
    assert.equal(pool.U, 1)
  })
})

// TC2 — a granted type is visible to tribal watchers: a Golem that "is a Zombie"
// triggers a "whenever a Zombie you control attacks" ability.
test('TC2 a granted type satisfies a tribal attack watcher', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const faux = await s.spawnCreature('A', 'Faux Zombie Test') // base Golem, granted Zombie
    await s.spawnCreature('A', 'Zombie Attack Watcher Test')
    await s.rebuild() // ensure the granted_type row is registered

    assert.match(await effType(s, faux), /Zombie/)

    const before = await s.client.query(
      `select life_total from public.game_session_players where session_id = $1 and player_id = $2`,
      [s.sessionId, s.players.A])

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(faux, 'B')
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()

    const after = await s.client.query(
      `select life_total from public.game_session_players where session_id = $1 and player_id = $2`,
      [s.sessionId, s.players.A])
    assert.equal(after.rows[0].life_total, before.rows[0].life_total + 1) // watcher fired
  })
})

// TC3 — a base-Golem WITHOUT the grant does not satisfy the Zombie watcher.
test('TC3 without the grant the tribal watcher does not fire', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const plain = await s.spawnCreature('A', 'Goblin Raider Test') // not a Zombie
    await s.spawnCreature('A', 'Zombie Attack Watcher Test')

    const before = await s.client.query(
      `select life_total from public.game_session_players where session_id = $1 and player_id = $2`,
      [s.sessionId, s.players.A])

    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(plain, 'B')
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()

    const after = await s.client.query(
      `select life_total from public.game_session_players where session_id = $1 and player_id = $2`,
      [s.sessionId, s.players.A])
    assert.equal(after.rows[0].life_total, before.rows[0].life_total) // no trigger
  })
})
