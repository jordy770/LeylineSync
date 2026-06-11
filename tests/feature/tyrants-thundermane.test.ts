// mig 244 — Leyline Tyrant + Hammerhead Tyrant + Thundermane Dragon.
//   • Leyline Tyrant: red mana survives step ends (mana_does_not_empty was
//     already enforced by clear_mana_pool_for_step — script-only); dies →
//     pay any amount of {R} → that much damage to a picked target.
//   • Hammerhead Tyrant: casting a spell parks a bounce pick over opponent
//     nonland permanents with mana value <= the cast spell's mana value.
//   • Thundermane Dragon: cast power-4+ creature spells from the top of your
//     library; cast this way they get haste until end of turn.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function pool(s: Scenario, seat: 'A' | 'B'): Promise<Record<string, number>> {
  const r = await s.client.query<{ mana_pool: Record<string, number> }>(
    'select mana_pool from public.game_players where session_id = $1 and player_id = $2',
    [s.sessionId, s.players[seat]])
  return r.rows[0]?.mana_pool ?? { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }
}

// LT1 — red mana survives a step end while Leyline Tyrant is on the battlefield.
test('LT1 Leyline Tyrant keeps red mana across step ends', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Leyline Tyrant Test')
    await s.as('A').rebuild() // register the mana_does_not_empty row
    await s.setMana('A', { R: 2, C: 1 })

    await s.as('A').advanceStep('A') // leaving the main phase clears the pool
    const p = await pool(s, 'A')
    assert.equal(p.R, 2) // retained
    assert.equal(p.C, 0) // everything else empties
  })
})

// LT2 — dies: pay 2 {R}, deal 2 to a picked creature.
test('LT2 Leyline Tyrant dies-trigger pays R for damage', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const tyrant = await s.spawnCreature('A', 'Leyline Tyrant Test')
    const victim = await s.spawnCreature('B', 'Dragon Token') // 5/5
    await s.setMana('A', { R: 3 })

    await s.putInGraveyard(tyrant)
    await s.as('A').resolveStack() // dies trigger -> pay_x_mana_damage parks
    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'pay_x_mana_damage')
    await s.as('A').submitDecision(d!.id, { amount: 2, game_card_id: victim })

    const dmg = await s.client.query<{ damage_marked: number }>(
      'select damage_marked from public.game_cards where id = $1', [victim])
    assert.equal(dmg.rows[0]!.damage_marked, 2)
    assert.equal((await pool(s, 'A')).R, 1) // 3 - 2 paid
  })
})

// HH1 — casting a 5-MV spell offers opponent nonland permanents with MV <= 5,
// excluding lands and bigger permanents; the pick goes to its owner's hand.
test('HH1 Hammerhead Tyrant bounce pick is capped at the cast spell mana value', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Hammerhead Tyrant Test')
    const cheap = await s.spawnCreature('B', 'Leyline Tyrant Test') // {2}{R}{R} = MV 4
    const big = await s.spawnCreature('B', 'Hammerhead Tyrant Test') // {4}{U}{U} = MV 6
    await s.spawn('B', 'Wastes Test', 'battlefield') // land — never offered

    const spell = await s.spawn('A', 'Rapacious Dragon Test', 'hand') // {4}{R} = MV 5
    await s.setMana('A', { R: 1, C: 4 })
    await s.as('A').castPermanent(spell)
    await s.as('A').resolveStack() // Hammerhead's cast watcher -> bounce_pick

    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'bounce_pick')
    const offered = (d!.options as { game_card_id: string }[]).map((o) => o.game_card_id)
    assert.deepEqual(offered.sort(), [cheap].sort()) // MV 4 only; MV 6 + land excluded
    assert.ok(!offered.includes(big))
    await s.as('A').submitDecision(d!.id, { chosen: [cheap] })

    const row = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [cheap])
    assert.equal(row.rows[0]!.zone, 'hand')
  })
})

// TM1 — a power-5 creature on top of the library can be cast and gets haste.
test('TM1 Thundermane allows casting a big creature off the top with haste', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Thundermane Dragon Test')
    await s.as('A').rebuild()
    const big = await s.spawn('A', 'Sarkhan, Soul Aflame Test', 'library') // 5/5, {3}{R}

    await s.setMana('A', { R: 1, C: 3 })
    await s.as('A').castPermanent(big)
    await s.as('A').resolveStack()

    const row = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [big])
    assert.equal(row.rows[0]!.zone, 'battlefield')
    const haste = await s.client.query(
      `select 1 from public.game_continuous_effects
       where session_id = $1 and affected_card_id = $2 and effect_type = 'haste'`,
      [s.sessionId, big])
    assert.ok(haste.rows.length >= 1)
  })
})

// TM2 — a small creature on top is rejected (power below the permission's
// min_power). The rejection must be the test's last action.
test('TM2 Thundermane refuses a small creature off the top', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Thundermane Dragon Test')
    await s.as('A').rebuild()
    const small = await s.spawn('A', 'Rapacious Dragon Test', 'library') // 3/3
    await s.setMana('A', { R: 1, C: 4 })

    await assert.rejects(
      () => s.as('A').castPermanent(small),
      /permission to cast that card from your library/)
  })
})
