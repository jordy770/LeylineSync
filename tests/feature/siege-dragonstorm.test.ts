// mig 245 — Frontier Siege + Breaching Dragonstorm.
//   • Frontier Siege: ETB "choose Khans or Dragons" (a word pick baked into
//     copied_script via the $chosen placeholder; the mode gate turns exactly
//     one half on). Khans: beginning of each of your main phases, add {G}{G}
//     (new beginning_of_main turn-step event + add_mana from triggers).
//     Dragons: an entering flyer you control may fight a target you don't
//     control (fighter:'triggering_creature').
//   • Breaching Dragonstorm: ETB exile-until-nonland; the nonland may enter
//     the battlefield free (MV <= 8) or go to hand on decline.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function chooseSiegeMode(s: Scenario, mode: 'Khans' | 'Dragons'): Promise<string> {
  const siege = await s.spawn('A', 'Frontier Siege Test', 'battlefield')
  await s.as('A').resolveStack() // ETB -> choose Khans or Dragons
  const d = await s.pendingDecision()
  assert.equal(d!.decision_type, 'choose_creature_type')
  const offered = (d!.options as { type: string }[]).map((o) => o.type)
  assert.deepEqual(offered, ['Khans', 'Dragons'])
  await s.as('A').submitDecision(d!.id, { type: mode })
  return siege
}

// FS1 — Khans: entering a main phase adds {G}{G}; before the choice nothing fires.
test('FS1 Frontier Siege Khans adds GG at each of your main phases', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await chooseSiegeMode(s, 'Khans')

    // Re-enter a main phase: the step change broadcasts beginning_of_main.
    await s.setTurn({ phase: 'beginning', step: 'upkeep', active: 'A', priority: 'A' })
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.as('A').resolveStack() // the Khans trigger

    const pool = await s.client.query<{ mana_pool: Record<string, number> }>(
      'select mana_pool from public.game_players where session_id = $1 and player_id = $2',
      [s.sessionId, s.players.A])
    assert.equal(pool.rows[0]!.mana_pool.G, 2)
  })
})

// FS2 — Dragons: an entering flyer fights the picked opposing creature.
test('FS2 Frontier Siege Dragons fights the entering flyer into a blocker', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await chooseSiegeMode(s, 'Dragons')
    const victim = await s.spawnCreature('B', 'Rapacious Dragon Test') // 3/3
    await s.as('B').resolveStack() // its ETB Treasures

    const flyer = await s.spawnCreature('A', 'Dragon Token') // 5/5 flying
    const trigger = await s.client.query<{ id: string }>(
      `select id from public.game_stack_items
       where session_id = $1 and status = 'pending' and action_type = 'triggered_ability'
       order by position desc limit 1`,
      [s.sessionId])
    await s.as('A').chooseTriggerTarget(trigger.rows[0]!.id, victim)
    await s.as('A').resolveStack()

    const rows = await s.client.query<{ zone: string; damage_marked: number }>(
      'select zone, damage_marked from public.game_cards where id = $1 or id = $2 order by id = $1 desc',
      [victim, flyer])
    const v = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [victim])
    assert.equal(v.rows[0]!.zone, 'graveyard') // 5 damage vs 3 toughness
    const f = await s.client.query<{ damage_marked: number }>(
      'select damage_marked from public.game_cards where id = $1', [flyer])
    assert.equal(f.rows[0]!.damage_marked, 3) // it fought back
    void rows
  })
})

// BD1 — exile two lands then the nonland; choosing it puts it onto the battlefield.
test('BD1 Breaching Dragonstorm free-casts the first nonland hit', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('A', 'Wastes Test', 'library')
    await s.spawn('A', 'Wastes Test', 'library')
    const hit = await s.spawn('A', 'Leyline Tyrant Test', 'library') // nonland, MV 4

    await s.spawn('A', 'Breaching Dragonstorm Test', 'battlefield')
    await s.as('A').resolveStack() // ETB -> exile until nonland, park the pick
    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'cast_exiled_free')
    await s.as('A').submitDecision(d!.id, { chosen: [hit] })

    const row = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [hit])
    assert.equal(row.rows[0]!.zone, 'battlefield')
    const exiled = await s.client.query<{ n: string }>(
      `select count(*)::int as n from public.game_cards gc join public.cards c on c.id = gc.card_id
       where gc.session_id = $1 and gc.zone = 'exile' and c.name = 'Wastes Test'`,
      [s.sessionId])
    assert.equal(Number(exiled.rows[0]!.n), 2) // the lands stay exiled
  })
})

// BD2 — declining puts the nonland into your hand instead.
test('BD2 Breaching Dragonstorm decline sends the card to hand', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const hit = await s.spawn('A', 'Leyline Tyrant Test', 'library')

    await s.spawn('A', 'Breaching Dragonstorm Test', 'battlefield')
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { chosen: [] })

    const row = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [hit])
    assert.equal(row.rows[0]!.zone, 'hand')
  })
})
