// mig 257 — the Veloci-Ramp-Tor "tail" batch (~10 cards). Engine touches:
//   • resolve_count_amount carries the SOURCE: exclude_self counts ("each
//     OTHER Dinosaur", Earthshaker Dreadmaw) + greatest_power_you_control
//     (Rishkar's Expertise / Return of the Wildspeaker, with type inversion).
//   • ignition (Chandra's Ignition): target creature deals its power to each
//     other creature and each opponent.
//   • activated choose_one routing (Shifting Ceratops); riot-style modal
//     watchers with reflexive mode actions (Rhythm of the Wild).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// DT1 — Dreadmaw draws per OTHER Dinosaur: one buddy = exactly one card.
test('DT1 Earthshaker Dreadmaw excludes itself from the count', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Dino Grunt Test') // the one OTHER Dinosaur
    for (let i = 0; i < 3; i++) await s.spawn('A', 'Wastes Test', 'library')

    await s.spawnCreature('A', 'Earthshaker Dreadmaw Test')
    await s.as('A').resolveStack()

    const hand = await s.client.query<{ n: string }>(
      `select count(*)::int as n from public.game_cards
       where session_id = $1 and owner_id = $2 and zone = 'hand'`,
      [s.sessionId, s.players.A])
    assert.equal(Number(hand.rows[0]!.n), 1) // not 2 — itself excluded
  })
})

// DT2 — Rishkar's Expertise: draw = greatest power, then a free MV<=5 put.
test('DT2 Rishkar draws by greatest power and offers the free put', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Dino Grunt Test') // 3/3
    await s.spawnCreature('A', 'Dragon Token') // 5/5 — the greatest
    for (let i = 0; i < 5; i++) await s.spawn('A', 'Wastes Test', 'library')
    const cheap = await s.spawn('A', 'Leyline Tyrant Test', 'hand') // MV 4

    await s.as('A').castSpellEffect([
      { type: 'draw', amount: { count: 'greatest_power_you_control' } },
      { type: 'put_from_hand', count: 1, filter: { permanent: true, max_mana_value: 5 } },
    ])
    await s.as('A').resolveStack()

    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'put_from_hand_pick')
    await s.as('A').submitDecision(d!.id, { chosen: [cheap] })

    const hand = await s.client.query<{ n: string }>(
      `select count(*)::int as n from public.game_cards
       where session_id = $1 and owner_id = $2 and zone = 'hand'`,
      [s.sessionId, s.players.A])
    assert.equal(Number(hand.rows[0]!.n), 5) // drew 5, put the held card down
    const row = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [cheap])
    assert.equal(row.rows[0]!.zone, 'battlefield')
  })
})

// DT3 — Chandra's Ignition: the 5/5 burns every other creature and B.
test('DT3 Chandra Ignition deals the target power around the table', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const big = await s.spawnCreature('A', 'Dragon Token') // 5/5
    const small = await s.spawnCreature('B', 'Dino Grunt Test') // 3/3 — dies
    const before = await s.client.query<{ life_total: number }>(
      'select life_total from public.game_session_players where session_id = $1 and player_id = $2',
      [s.sessionId, s.players.B])

    await s.as('A').castSpellEffect(
      [{ type: 'ignition', target_type: 'creature', target_controller: 'you' }], null, null, big)
    await s.as('A').resolveStack()

    const dead = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [small])
    assert.equal(dead.rows[0]!.zone, 'graveyard') // 5 damage kills the 3/3
    const after = await s.client.query<{ life_total: number }>(
      'select life_total from public.game_session_players where session_id = $1 and player_id = $2',
      [s.sessionId, s.players.B])
    assert.equal(after.rows[0]!.life_total, before.rows[0]!.life_total - 5)
    const self = await s.client.query<{ damage_marked: number }>(
      'select damage_marked from public.game_cards where id = $1', [big])
    assert.equal(self.rows[0]!.damage_marked, 0) // not itself
  })
})

// DT4 — Rhythm of the Wild gives an entering nontoken creature riot: the
// haste mode lands on the TRIGGERING creature.
test('DT4 Rhythm of the Wild riot grants haste to the newcomer', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Rhythm of the Wild Test', 'battlefield')

    const dino = await s.spawnCreature('A', 'Dino Grunt Test')
    await s.as('A').resolveStack() // the riot modal parks
    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'choose_mode')
    await s.as('A').submitDecision(d!.id, { chosen: [1] }) // haste

    const haste = await s.client.query(
      `select 1 from public.game_continuous_effects
       where session_id = $1 and affected_card_id = $2 and effect_type = 'haste'`,
      [s.sessionId, dino])
    assert.ok(haste.rows.length >= 1)
  })
})
