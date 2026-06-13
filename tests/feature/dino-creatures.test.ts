// mig 256 — the Veloci-Ramp-Tor creature batch (~14 cards, mostly scripts).
// Engine touches under test:
//   • gain_life amount {toughness_of:'triggering_creature'} (Verdant Sun's
//     Avatar).
//   • destroy_all exclude_type ("destroy all non-Dinosaur creatures",
//     Wakening Sun's Avatar — the cast-from-hand condition is not modelled).
//   • add_counters_all exclude_source (Bellowing Aegisaur's enrage).
//   • the dinos_combat_damage tally/broadcast (Curious Altisaur; batched per
//     damaged player).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function life(s: Scenario, seat: 'A' | 'B'): Promise<number> {
  const r = await s.client.query<{ life_total: number }>(
    'select life_total from public.game_session_players where session_id = $1 and player_id = $2',
    [s.sessionId, s.players[seat]])
  return r.rows[0]!.life_total
}

// VC1 — Verdant Sun's Avatar gains life equal to each entering creature's
// toughness (its own entry included).
test('VC1 Verdant Sun gains life by entering toughness', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const before = await life(s, 'A')

    await s.spawnCreature('A', 'Verdant Suns Avatar Test') // 5/5 — its own entry
    await s.as('A').resolveStack()
    assert.equal(await life(s, 'A'), before + 5)

    await s.spawnCreature('A', 'Dino Grunt Test') // 3/3
    await s.as('A').resolveStack()
    assert.equal(await life(s, 'A'), before + 5 + 3)
  })
})

// VC2 — Wakening Sun's Avatar wipes only the non-Dinosaurs.
test('VC2 Wakening Sun destroys all non-Dinosaur creatures', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const dino = await s.spawnCreature('A', 'Dino Grunt Test')
    const dragon = await s.spawnCreature('B', 'Sarkhan, Soul Aflame Test') // Human, not Dino

    await s.spawnCreature('A', 'Wakening Suns Avatar Test')
    await s.as('A').resolveStack()

    const d = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [dino])
    assert.equal(d.rows[0]!.zone, 'battlefield') // Dinosaur survives
    const g = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [dragon])
    assert.equal(g.rows[0]!.zone, 'graveyard')
  })
})

// VC3 — Bellowing Aegisaur enrages: counters on each OTHER creature you control.
test('VC3 Bellowing Aegisaur counters every other creature', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const aegisaur = await s.spawnCreature('A', 'Bellowing Aegisaur Test')
    const buddy = await s.spawnCreature('A', 'Dino Grunt Test')
    const enemy = await s.spawnCreature('B', 'Dino Grunt Test')

    await s.as('A').castSpellEffect(
      [{ type: 'deal_damage', amount: 1, target_type: 'creature' }], null, null, aegisaur)
    await s.as('A').resolveStack()
    await s.as('A').resolveStack() // enrage

    const rows = await s.client.query<{ id: string; plus_one_counters: number }>(
      'select id, plus_one_counters from public.game_cards where id in ($1, $2, $3)',
      [aegisaur, buddy, enemy])
    const byId = new Map(rows.rows.map((r) => [r.id, r.plus_one_counters]))
    assert.equal(byId.get(buddy), 1) // other creature you control
    assert.equal(byId.get(aegisaur), 0) // not itself
    assert.equal(byId.get(enemy), 0) // not the opponent's
  })
})

// VC4 — a Dinosaur connecting draws Curious Altisaur's controller a card.
test('VC4 Curious Altisaur draws on Dinosaur combat damage', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Curious Altisaur Test')
    const grunt = await s.spawnCreature('A', 'Dino Grunt Test')
    await s.spawn('A', 'Wastes Test', 'library')

    await s.as('A').declareAttacker(grunt, 'B')
    await s.setTurn({ phase: 'combat', step: 'combat_damage', active: 'A', priority: 'A' })
    await s.as('A').resolveCombat()
    await s.as('A').resolveStack() // the dinos_combat_damage trigger

    const hand = await s.client.query<{ n: string }>(
      `select count(*)::int as n from public.game_cards
       where session_id = $1 and owner_id = $2 and zone = 'hand'`,
      [s.sessionId, s.players.A])
    assert.equal(Number(hand.rows[0]!.n), 1)
  })
})
