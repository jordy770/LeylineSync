// mig 261 — Veloci-Ramp-Tor fights batch. Engine touches:
//   • 'fight_pick' program action + decision: the program's target fights a
//     SECOND parked pick (Savage Stomp spell, Wayta activated — the
//     single-effect activated routing now carries the target).
//   • Per-attacker 'dealt_combat_damage_to_player' event (Scion of
//     Calamity); destroy_up_to gains a `types` array filter.
//   • Progenitor's Icon is script-only (any-color mana; flash unmodelled).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// DF1 — Savage Stomp: counter first, then the buffed creature wins the fight.
test('DF1 Savage Stomp counters then fights', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const mine = await s.spawnCreature('A', 'Dino Grunt Test') // 3/3 → 4/4
    const theirs = await s.spawnCreature('B', 'Dino Grunt Test') // 3/3

    await s.as('A').castSpellEffect([
      { type: 'add_counters', amount: 1, target_type: 'creature', target_controller: 'you' },
      { type: 'fight_pick', target_filter: { controller: 'opponent' } },
    ], null, null, mine)
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'fight_pick')
    await s.as('A').submitDecision(d!.id, { chosen: [theirs] })

    const loser = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [theirs])
    assert.equal(loser.rows[0]!.zone, 'graveyard') // 4 damage kills the 3/3
    const winner = await s.client.query<{ zone: string; damage_marked: number }>(
      'select zone, damage_marked from public.game_cards where id = $1', [mine])
    assert.equal(winner.rows[0]!.zone, 'battlefield') // 3 damage vs 4 toughness
    assert.equal(winner.rows[0]!.damage_marked, 3)
  })
})

// DF2 — Wayta: the activated fight via the same parked pick.
test('DF2 Wayta activated fight', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const wayta = await s.spawnCreature('A', 'Wayta Prodigy Test')
    const mine = await s.spawnCreature('A', 'Dino Grunt Test') // 3/3
    const theirs = await s.spawnCreature('B', 'Dino Grunt Test') // 3/3
    await s.setMana('A', { G: 1, C: 2 })

    await s.as('A').activate(wayta, 0, { targetCardId: mine }) // the only activated ability
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'fight_pick')
    await s.as('A').submitDecision(d!.id, { chosen: [theirs] })

    const a = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [mine])
    const b = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [theirs])
    assert.equal(a.rows[0]!.zone, 'graveyard') // 3/3 vs 3/3 — both die
    assert.equal(b.rows[0]!.zone, 'graveyard')
  })
})

// DF3 — Scion of Calamity: combat damage to a player destroys their artifact.
test('DF3 Scion destroys an artifact after connecting', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const scion = await s.spawnCreature('A', 'Scion of Calamity Test') // 5/5
    const ring = await s.spawn('B', 'Green Mana Vessel Test', 'battlefield')
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.as('A').declareAttacker(scion, 'B')
    await s.setTurn({ phase: 'combat', step: 'combat_damage', active: 'A', priority: 'A' })
    await s.resolveCombat()

    await s.as('A').resolveStack() // the dealt_combat_damage_to_player trigger
    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'destroy_pick')
    await s.as('A').submitDecision(d!.id, { chosen: [ring] })

    const row = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [ring])
    assert.equal(row.rows[0]!.zone, 'graveyard')
  })
})
