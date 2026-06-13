// Infect / toxic / wither combat (roadmap Counters #7). Combat damage routed into the
// poison and −1/−1 counter destinations: infect → poison to players / −1/−1 to creatures;
// wither → −1/−1 to creatures (players normal); toxic N → +N poison on top of normal
// damage to a player. Poison ≥ 10 loses via the combat-end maybe_finish.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function playerRow(s: Scenario, seat: 'A' | 'B'): Promise<{ life: number; counters: Record<string, number> }> {
  const r = await s.client.query<{ life_total: number; counters: Record<string, number> }>(
    'select life_total, counters from public.game_session_players where session_id = $1 and player_id = $2',
    [s.sessionId, s.playerId(seat)],
  )
  return { life: Number(r.rows[0]!.life_total), counters: r.rows[0]?.counters ?? {} }
}
async function cardBag(s: Scenario, card: string): Promise<Record<string, number>> {
  const r = await s.client.query<{ counters: Record<string, number> }>('select counters from public.game_cards where id = $1', [card])
  return r.rows[0]?.counters ?? {}
}
async function effectiveT(s: Scenario, card: string): Promise<number> {
  const r = await s.client.query<{ t: number }>('select public.card_effective_toughness($1, $2) as t', [s.sessionId, card])
  return Number(r.rows[0]!.t)
}

// Attack `attackerName` (A) into B, unblocked, land on combat_damage with A priority.
async function attackUnblocked(s: Scenario, attackerName: string): Promise<string> {
  const attacker = await s.spawnCreature('A', attackerName)
  await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
  await s.as('A').declareAttacker(attacker, 'B')
  await s.setTurn({ phase: 'combat', step: 'combat_damage', active: 'A', priority: 'A' })
  return attacker
}

// A attacks with `attackerName`; B blocks with `blockerName`. Lands on combat_damage.
async function block(s: Scenario, attackerName: string, blockerName: string) {
  const attacker = await s.spawnCreature('A', attackerName)
  const blocker = await s.spawnCreature('B', blockerName)
  await s.setTurn({ phase: 'combat', step: 'declare_attackers', active: 'A', priority: 'A' })
  await s.as('A').declareAttacker(attacker, 'B')
  await s.setTurn({ phase: 'combat', step: 'declare_blockers', active: 'A', priority: 'B' })
  await s.as('B').declareBlocker(blocker, attacker)
  await s.setTurn({ phase: 'combat', step: 'combat_damage', active: 'A', priority: 'A' })
  return { attacker, blocker }
}

// IW1 — unblocked infect deals poison to the player, not life loss.
test('IW1 infect to a player is poison, not life', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await attackUnblocked(s, 'Infect Crawler Test') // 2/2 infect
    await s.as('A').resolveCombat()

    const b = await playerRow(s, 'B')
    assert.equal(b.life, 20) // no life loss
    assert.equal(b.counters.poison, 2) // 2 poison instead
  })
})

// IW2 — infect to a creature is −1/−1 counters, not marked damage.
test('IW2 infect to a creature is -1/-1 counters', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const { blocker } = await block(s, 'Infect Crawler Test', 'Air Elemental Test') // 2/2 infect vs 4/4
    await s.as('A').resolveCombat()

    assert.equal((await cardBag(s, blocker)).minus_one_one, 2)
    assert.equal(Number((await s.cardState(blocker)).damage_marked), 0)
    assert.equal(await effectiveT(s, blocker), 2) // 4/4 → 2/2
    assert.equal(await s.zoneOf(blocker), 'battlefield')
  })
})

// IW3 — wither to a creature is −1/−1 counters; wither does NOT affect players.
test('IW3 wither is -1/-1 to creatures, normal to players', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const { blocker } = await block(s, 'Wither Striker Test', 'Air Elemental Test') // 3/3 wither vs 4/4
    await s.as('A').resolveCombat()

    assert.equal((await cardBag(s, blocker)).minus_one_one, 3)
    assert.equal(Number((await s.cardState(blocker)).damage_marked), 0)
    assert.equal(await effectiveT(s, blocker), 1) // 4/4 → 1/1
  })
})

// IW3b — unblocked wither deals normal combat damage to the player (no poison).
test('IW3b wither to a player is normal damage', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await attackUnblocked(s, 'Wither Striker Test') // 3/3 wither
    await s.as('A').resolveCombat()

    const b = await playerRow(s, 'B')
    assert.equal(b.life, 17) // normal 3 damage
    assert.equal(b.counters.poison ?? 0, 0)
  })
})

// IW4 — toxic adds poison ON TOP of normal combat damage to the player.
test('IW4 toxic adds poison on top of normal damage', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await attackUnblocked(s, 'Toxic Biter Test') // 2/2 toxic 2
    await s.as('A').resolveCombat()

    const b = await playerRow(s, 'B')
    assert.equal(b.life, 18) // normal 2 damage
    assert.equal(b.counters.poison, 2) // plus 2 poison
  })
})

// IW5 — infect poison can reach the 10-poison loss via the combat-end SBA.
test('IW5 infect poison to 10 loses the game', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    // Pre-load B with 9 poison; a 2-power infect attacker pushes to 11 (≥ 10).
    await s.client.query(
      `update public.game_session_players set counters = '{"poison":9}'::jsonb where session_id = $1 and player_id = $2`,
      [s.sessionId, s.playerId('B')],
    )
    await attackUnblocked(s, 'Infect Crawler Test')
    const result = await s.as('A').resolveCombat()

    assert.equal((result as { finished: boolean }).finished, true)
    assert.equal((result as { winner_player_id: string }).winner_player_id, s.playerId('A'))
  })
})
