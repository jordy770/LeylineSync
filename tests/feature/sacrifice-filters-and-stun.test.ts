// mig 402 — subtype/another filters on sacrifice costs (Professional
// Face-Breaker's "Sacrifice a Treasure", Kalitas' "another Vampire or Zombie");
// mig 403 — stun: a tap effect with stun:true adds a 'stun' bag counter and
// advance_step's untap skips the permanent once per counter (Frost Titan).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// SF1 — the Treasure-only cost eats the Treasure, spares other artifacts, and
// rejects once no Treasure is left (expected rejection LAST — aborted-tx rule).
test('SF1 sacrifice_artifacts type_line picks only matching artifacts', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const cracker = await s.spawn('A', 'Treasure Cracker Test', 'battlefield')
    const wellspring = await s.spawn('A', 'Ichor Wellspring Test', 'battlefield')
    // Mint a real Treasure token (cheapest by MV would ALSO be the Treasure —
    // the rejection below is what proves the filter, not the pick order).
    await s.as('A').castSpellEffect([{ type: 'create_token', token: 'Treasure Token', count: 1 }])
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()

    await s.as('A').activate(cracker, 0)
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(wellspring), 'battlefield')
    const r = await s.client.query(
      `select life_total from public.game_session_players where session_id = $1 and player_id = $2`,
      [s.sessionId, s.players.A])
    assert.equal(r.rows[0].life_total, 22)

    // No Treasure left — the Wellspring must NOT be an acceptable payment.
    await assert.rejects(s.as('A').activate(cracker, 0), /sacrifice/)
  })
})

// SF2 — sacrifice_creature type_line_any + another: a Zombie pays; the source
// itself is refused (expected rejection LAST).
test('SF2 sacrifice_creature honors type_line_any and another', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const butcher = await s.spawnCreature('A', 'Tribal Butcher Test')
    const zombie = await s.spawnCreature('A', 'Grave Shambler Test')

    await s.as('A').activate(butcher, 0, { targetCardId: zombie })
    while ((await s.pendingCount()) > 0) await s.as('A').resolveStack()
    assert.equal(await s.zoneOf(zombie), 'graveyard')
    const r = await s.client.query(
      `select plus_one_counters from public.game_cards where id = $1`, [butcher])
    assert.equal(r.rows[0].plus_one_counters, 2)

    // The source is a Vampire but 'another' forbids feeding it to itself.
    await assert.rejects(
      s.as('A').activate(butcher, 0, { targetCardId: butcher }),
      /matching creature/,
    )
  })
})

// ST1 — a stun-tapped permanent skips exactly one of its untap steps.
test('ST1 stun skips one untap step, then unstuns', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const bear = await s.spawnCreature('A', 'Goblin Raider Test')
    await s.client.query(
      `select public.apply_creature_effect($1, 'tap', $2, '{"stun": true}'::jsonb)`,
      [s.sessionId, bear])

    const tapped = async () => {
      const r = await s.client.query('select is_tapped from public.game_cards where id = $1', [bear])
      return r.rows[0].is_tapped
    }
    assert.equal(await tapped(), true)

    // A's untap step: the stun counter is consumed, the bear STAYS tapped.
    await s.setTurn({ phase: 'beginning', step: 'untap', active: 'A', priority: 'A' })
    await s.as('A').advanceStep()
    assert.equal(await tapped(), true)

    // Next untap step: no counter left — it untaps normally.
    await s.setTurn({ phase: 'beginning', step: 'untap', active: 'A', priority: 'A' })
    await s.as('A').advanceStep()
    assert.equal(await tapped(), false)
  })
})
