// mig 246 — Opportunistic Dragon: "When this creature enters, choose target
// Human or artifact an opponent controls. For as long as this creature
// remains on the battlefield, gain control of that permanent, it loses all
// abilities, and it can't attack or block."
//   • gain_control duration 'while_source': an unexpiring control row sourced
//     by the thief; fire_zone_change_triggers reverts when it leaves.
//   • lose_abilities: copied_script becomes a stub that blanks the script and
//     blocks attacking via cant_attack_unless. (Block restriction and the
//     Human-or-artifact type check are not enforced server-side.)

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// OD1 — steal, blank, then revert when the Dragon dies.
test('OD1 Opportunistic Dragon steals while it remains, then gives back', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const loot = await s.spawnCreature('B', 'Rapacious Dragon Test')
    await s.as('B').resolveStack() // its ETB Treasures

    const dragon = await s.spawnCreature('A', 'Opportunistic Dragon Test')
    const trigger = await s.client.query<{ id: string }>(
      `select id from public.game_stack_items
       where session_id = $1 and status = 'pending' and action_type = 'triggered_ability'
       order by position desc limit 1`,
      [s.sessionId])
    await s.as('A').chooseTriggerTarget(trigger.rows[0]!.id, loot)
    await s.as('A').resolveStack()

    let row = await s.client.query<{ controller: string; cs: string | null }>(
      `select coalesce(controller_player_id, owner_id) as controller, copied_script::text as cs
       from public.game_cards where id = $1`, [loot])
    assert.equal(row.rows[0]!.controller, s.players.A) // stolen
    assert.match(row.rows[0]!.cs ?? '', /cant_attack_unless/) // blanked + grounded

    await s.putInGraveyard(dragon) // the thief leaves -> everything reverts
    row = await s.client.query<{ controller: string; cs: string | null }>(
      `select coalesce(controller_player_id, owner_id) as controller, copied_script::text as cs
       from public.game_cards where id = $1`, [loot])
    assert.equal(row.rows[0]!.controller, s.players.B)
    assert.equal(row.rows[0]!.cs, null)
    const rows = await s.client.query(
      `select 1 from public.game_continuous_effects
       where session_id = $1 and effect_type = 'control' and source_card_id = $2`,
      [s.sessionId, dragon])
    assert.equal(rows.rows.length, 0)
  })
})
