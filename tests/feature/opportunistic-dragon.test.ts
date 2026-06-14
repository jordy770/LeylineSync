// mig 246 / mig 310 — Opportunistic Dragon: "When this creature enters, choose
// target Human or artifact an opponent controls. For as long as this creature
// remains on the battlefield, gain control of that permanent, it loses all
// abilities, and it can't attack or block."
//   • gain_control duration 'while_source': an unexpiring control row sourced
//     by the thief; fire_zone_change_triggers reverts when it leaves.
//   • lose_abilities: copied_script becomes a stub that blanks the script and
//     blocks attacking via cant_attack_unless.
//   • mig 310: the "Human or artifact" restriction is now enforced via the
//     trigger's target_filter (type_line_any) — the trigger isn't enqueued when
//     no legal target exists, and choosing an illegal target is rejected.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function pendingTrigger(s: Scenario): Promise<string | null> {
  const r = await s.client.query<{ id: string }>(
    `select id from public.game_stack_items
     where session_id = $1 and status = 'pending' and action_type = 'triggered_ability'
     order by position desc limit 1`,
    [s.sessionId])
  return r.rows[0]?.id ?? null
}

// OD1 — steal a legal target (an artifact), blank it, then revert on death.
test('OD1 Opportunistic Dragon steals an artifact while it remains, then gives back', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const loot = await s.spawn('B', 'Unstable Obelisk Test', 'battlefield') // an artifact — legal

    const dragon = await s.spawnCreature('A', 'Opportunistic Dragon Test')
    const trigger = await pendingTrigger(s)
    assert.ok(trigger, 'trigger enqueued — a legal (artifact) target exists')
    await s.as('A').chooseTriggerTarget(trigger!, loot)
    await s.as('A').resolveStack()

    let row = await s.client.query<{ controller: string; cs: string | null }>(
      `select coalesce(controller_player_id, owner_id) as controller, copied_script::text as cs
       from public.game_cards where id = $1`, [loot])
    assert.equal(row.rows[0]!.controller, s.players.A) // stolen
    assert.match(row.rows[0]!.cs ?? '', /cant_attack_unless/) // blanked

    await s.putInGraveyard(dragon) // the thief leaves -> everything reverts
    row = await s.client.query<{ controller: string; cs: string | null }>(
      `select coalesce(controller_player_id, owner_id) as controller, copied_script::text as cs
       from public.game_cards where id = $1`, [loot])
    assert.equal(row.rows[0]!.controller, s.players.B)
    assert.equal(row.rows[0]!.cs, null)
  })
})

// OD2 — no Human/artifact in range: the trigger isn't even enqueued (no soft-lock
// on an unresolvable "choose target").
test('OD2 trigger is not enqueued when the opponent has no Human or artifact', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('B', 'Air Elemental Test') // an Elemental — not Human, not artifact

    await s.spawnCreature('A', 'Opportunistic Dragon Test')
    assert.equal(await pendingTrigger(s), null, 'no legal target -> no trigger on the stack')
  })
})

// OD3 — an illegal target is rejected even when the trigger fired off a legal one.
// (assert.rejects aborts the tx, so it's the last action.)
test('OD3 choosing a non-Human, non-artifact target is rejected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawn('B', 'Unstable Obelisk Test', 'battlefield') // legal -> enqueues the trigger
    const elemental = await s.spawnCreature('B', 'Air Elemental Test') // illegal target

    await s.spawnCreature('A', 'Opportunistic Dragon Test')
    const trigger = await pendingTrigger(s)
    assert.ok(trigger, 'trigger enqueued (a legal artifact exists)')

    await assert.rejects(
      () => s.as('A').chooseTriggerTarget(trigger!, elemental) as Promise<unknown>,
      /type restriction/,
    )
  })
})
