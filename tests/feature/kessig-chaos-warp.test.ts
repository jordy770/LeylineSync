// mig 242 — Kessig Wolf Run + Chaos Warp.
//   • Kessig Wolf Run: "{X}{R}{G}, {T}: Target creature gets +X/+0 and gains
//     trample" — activate_ability's new p_x_value pays {X} as generic mana
//     and substitutes the literal 'X' in the effects; the multi-effect path
//     carries the target.
//   • Chaos Warp: shuffle target permanent into its owner's library, then the
//     revealed top card enters the battlefield if it's a permanent card.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// KW1 — X=3: the target gets +3/+0 and trample until end of turn.
test('KW1 Kessig Wolf Run pumps +X/+0 and grants trample', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const wolfRun = await s.spawn('A', 'Kessig Wolf Run Test', 'battlefield')
    const dragon = await s.spawnCreature('A', 'Rapacious Dragon Test') // 3/3
    await s.as('A').resolveStack() // its ETB Treasures

    await s.setMana('A', { C: 3, R: 1, G: 1 })
    await s.as('A').activate(wolfRun, 1, { targetCardId: dragon, xValue: 3 })
    await s.as('A').resolveStack()

    assert.equal(await s.effectivePower(dragon), 6) // 3 base + X=3
    const trample = await s.client.query(
      `select 1 from public.game_continuous_effects
       where session_id = $1 and affected_card_id = $2 and effect_type = 'trample'`,
      [s.sessionId, dragon])
    assert.ok(trample.rows.length >= 1)
    const tapped = await s.client.query<{ is_tapped: boolean }>(
      'select is_tapped from public.game_cards where id = $1', [wolfRun])
    assert.equal(tapped.rows[0]!.is_tapped, true)
  })
})

// KW2 — an {X} cost without a chosen X is rejected (must be the last action:
// a rejection aborts the rolled-back tx).
test('KW2 activating an {X} ability without an X is rejected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const wolfRun = await s.spawn('A', 'Kessig Wolf Run Test', 'battlefield')
    const dragon = await s.spawnCreature('A', 'Rapacious Dragon Test')
    await s.as('A').resolveStack()
    await s.setMana('A', { C: 3, R: 1, G: 1 })

    await assert.rejects(
      () => s.as('A').activate(wolfRun, 1, { targetCardId: dragon }),
      /requires a chosen X/)
  })
})

// CW1 — Chaos Warp a nontoken creature whose owner's library is empty: it is
// shuffled in as the only card, revealed, and (being a permanent) returns to
// the battlefield — both halves of the card in one deterministic pass.
test('CW1 Chaos Warp shuffles in, then the revealed permanent enters', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const target = await s.spawnCreature('B', 'Sarkhan, Soul Aflame Test') // B's, nontoken, no ETB

    await s.as('A').castSpellEffect(
      [{ type: 'shuffle_into_library', target_type: 'permanent', then_reveal_top_to_battlefield: true }],
      null, null, target)
    await s.as('A').resolveStack()

    const row = await s.client.query<{ zone: string; controller: string }>(
      `select zone, coalesce(controller_player_id, owner_id) as controller
       from public.game_cards where id = $1`, [target])
    assert.equal(row.rows[0]!.zone, 'battlefield')
    assert.equal(row.rows[0]!.controller, s.players.B)
  })
})

// CW2 — a TOKEN warped away ceases instead of coming back.
test('CW2 Chaos Warp on a token removes it from the game', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const target = await s.spawnCreature('B', 'Dragon Token')

    await s.as('A').castSpellEffect(
      [{ type: 'shuffle_into_library', target_type: 'permanent', then_reveal_top_to_battlefield: true }],
      null, null, target)
    await s.as('A').resolveStack()

    const gone = await s.client.query('select 1 from public.game_cards where id = $1', [target])
    assert.equal(gone.rows.length, 0)
  })
})
