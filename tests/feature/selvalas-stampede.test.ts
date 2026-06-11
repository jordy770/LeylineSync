// mig 252 — Selvala's Stampede (council's dilemma voting): starting with the
// caster, each player votes wild or free. Wild: reveal from the caster's
// library top until that many creature cards entered under them (other
// revealed cards bottom in a random order — approximating the shuffle).
// Free: a put-from-hand pick for that many permanents.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// SS1 — A votes wild, B votes free: one creature off the top enters, then a
// one-card put-from-hand pick resolves.
test('SS1 Selvala vote chain applies wild and free results', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Wastes Test', 'library') // top: a nonmatch to reveal past
    const creature = await s.spawn('A', 'Leyline Tyrant Test', 'library')
    const handCard = await s.spawn('A', 'Sarkhan, Soul Aflame Test', 'hand')

    await s.as('A').castSpellEffect([
      { type: 'vote_wild_free' },
      { type: 'put_from_hand', count: 'free_votes', filter: { permanent: true } },
    ])
    await s.as('A').resolveStack()

    // Starting with the caster: A first, then B.
    let d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'vote')
    assert.equal(d!.deciding_player_id, s.players.A)
    await s.as('A').submitDecision(d!.id, { value: 'wild' })

    d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'vote')
    assert.equal(d!.deciding_player_id, s.players.B)
    await s.as('B').submitDecision(d!.id, { value: 'free' })

    // Wild applied: the creature is on the battlefield, the land bottomed.
    const c = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [creature])
    assert.equal(c.rows[0]!.zone, 'battlefield')

    // Free applied: a put-from-hand pick for one card.
    d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'put_from_hand_pick')
    assert.equal(d!.max_choices, 1)
    await s.as('A').submitDecision(d!.id, { chosen: [handCard] })
    const h = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [handCard])
    assert.equal(h.rows[0]!.zone, 'battlefield')
  })
})

// SS2 — zero free votes: the put-from-hand action is skipped entirely.
test('SS2 all-wild votes skip the free puts', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const c1 = await s.spawn('A', 'Leyline Tyrant Test', 'library')
    const c2 = await s.spawn('A', 'Sarkhan, Soul Aflame Test', 'library')
    await s.spawn('A', 'Rapacious Dragon Test', 'hand') // would be pickable

    await s.as('A').castSpellEffect([
      { type: 'vote_wild_free' },
      { type: 'put_from_hand', count: 'free_votes', filter: { permanent: true } },
    ])
    await s.as('A').resolveStack()

    let d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { value: 'wild' })
    d = await s.pendingDecision()
    await s.as('B').submitDecision(d!.id, { value: 'wild' })

    // Two wild votes: both creatures entered; no further decision parked.
    for (const id of [c1, c2]) {
      const r = await s.client.query<{ zone: string }>(
        'select zone from public.game_cards where id = $1', [id])
      assert.equal(r.rows[0]!.zone, 'battlefield')
    }
    assert.equal(await s.pendingDecision(), null)
  })
})
