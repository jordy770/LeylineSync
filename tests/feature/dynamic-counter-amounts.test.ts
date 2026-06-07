// State-referencing dynamic amounts (roadmap Counters #5 half 2 + #8 half 2). A
// trigger/source effect's amount can be { counters: <kind>, of: "self" | "you" },
// resolved at apply time to that counter count — "equal to the number of +1/+1
// counters on ~" / "equal to your experience counters". resolve_dynamic_amount,
// threaded into apply_triggered_ability_effects.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function setPlayerCounter(s: Scenario, seat: 'A' | 'B', kind: string, n: number): Promise<void> {
  await s.client.query(
    `update public.game_session_players
       set counters = jsonb_set(coalesce(counters, '{}'::jsonb), array[$3], to_jsonb($4::int))
     where session_id = $1 and player_id = $2`,
    [s.sessionId, s.playerId(seat), kind, n],
  )
}

// DA1 — gain life equal to THIS permanent's +1/+1 counters (of: self).
test('DA1 amount = +1/+1 counters on self', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const sage = await s.spawnCreature('A', 'Counter Sage Test')
    await s.client.query('update public.game_cards set plus_one_counters = 3 where id = $1', [sage])
    const before = await s.lifeOf('A')

    await s.setTurn({ phase: 'ending', step: 'end', active: 'A', priority: 'A' })
    await s.resolveStack()

    assert.equal(await s.lifeOf('A'), before + 3)
  })
})

// DA2 — gain life equal to the controller's experience counters (of: you).
test('DA2 amount = your experience counters', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawnCreature('A', 'Experience Sage Test')
    await setPlayerCounter(s, 'A', 'experience', 2)
    const before = await s.lifeOf('A')

    await s.setTurn({ phase: 'ending', step: 'end', active: 'A', priority: 'A' })
    await s.resolveStack()

    assert.equal(await s.lifeOf('A'), before + 2)
  })
})

// DA3 — a dynamic amount of 0 (no counters) is a clean no-op, not an error.
test('DA3 zero counters resolves to no gain', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.spawnCreature('A', 'Counter Sage Test') // 0 +1/+1 counters
    const before = await s.lifeOf('A')

    await s.setTurn({ phase: 'ending', step: 'end', active: 'A', priority: 'A' })
    await s.resolveStack()

    assert.equal(await s.lifeOf('A'), before)
  })
})

// DA4 — dynamic add_counters: put +1/+1 counters equal to your experience.
test('DA4 add_counters amount = your experience', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const grafter = await s.spawnCreature('A', 'Experience Grafter Test')
    await setPlayerCounter(s, 'A', 'experience', 2)

    await s.setTurn({ phase: 'ending', step: 'end', active: 'A', priority: 'A' })
    await s.resolveStack()

    assert.equal((await s.cardState(grafter)).plus_one_counters, 2)
  })
})
