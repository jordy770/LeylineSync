// Energy as an activation cost (roadmap Counters #8, consumable half). An activated
// ability with a { type: 'energy', amount: N } cost spends N energy counters from the
// activating player's pool (game_session_players.counters->>'energy'). Affordability is
// checked before the effect lands; insufficient energy raises and spends nothing.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function setEnergy(s: Scenario, seat: 'A' | 'B', n: number): Promise<void> {
  await s.client.query(
    `update public.game_session_players
       set counters = jsonb_set(coalesce(counters, '{}'::jsonb), '{energy}', to_jsonb($3::int))
     where session_id = $1 and player_id = $2`,
    [s.sessionId, s.playerId(seat), n],
  )
}
async function energyOf(s: Scenario, seat: 'A' | 'B'): Promise<number> {
  const r = await s.client.query<{ e: number }>(
    `select coalesce((counters ->> 'energy')::int, 0) as e
       from public.game_session_players where session_id = $1 and player_id = $2`,
    [s.sessionId, s.playerId(seat)],
  )
  return Number(r.rows[0]!.e)
}

// EN1 — paying an energy cost spends the energy and resolves the effect.
test('EN1 energy cost is spent and the ability resolves', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await setEnergy(s, 'A', 3)
    const drinker = await s.spawnCreature('A', 'Energy Drinker Test') // Pay two energy: draw
    await s.spawn('A', 'Air Elemental Test', 'library')
    const handBefore = await s.zoneCount('A', 'hand')

    await s.as('A').activate(drinker, 0)
    await s.as('A').resolveStack()

    assert.equal(await energyOf(s, 'A'), 1) // 3 − 2
    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 1)
  })
})

// EN2 — too little energy raises and spends nothing.
test('EN2 insufficient energy is rejected and spends nothing', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await setEnergy(s, 'A', 1)
    const drinker = await s.spawnCreature('A', 'Energy Drinker Test')

    // The raising RPC aborts the tx; a savepoint lets us read state afterwards.
    await s.client.query('savepoint en2')
    await assert.rejects(() => s.as('A').activate(drinker, 0), /[Nn]ot enough energy/)
    await s.client.query('rollback to savepoint en2')
    assert.equal(await energyOf(s, 'A'), 1) // unchanged
  })
})

// EN3 — spending to exactly 0 works, and a further activation is then rejected.
test('EN3 energy depletes and blocks the next activation', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await setEnergy(s, 'A', 2)
    const drinker = await s.spawnCreature('A', 'Energy Drinker Test')

    await s.as('A').activate(drinker, 0) // 2 → 0
    assert.equal(await energyOf(s, 'A'), 0)
    await s.as('A').resolveStack()

    await assert.rejects(() => s.as('A').activate(drinker, 0), /[Nn]ot enough energy/)
  })
})
