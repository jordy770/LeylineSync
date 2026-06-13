// −1/−1 counters (roadmap Counters #4). Stored as the bag key 'minus_one_one' (so
// proliferate / removal / judge tools reuse the multi-counter infra), but unlike other
// bag counters it LOWERS effective P/T at the counter layer, kills at 0 toughness, and
// annihilates against +1/+1 counters in pairs (CR 122.3) via recheck_counter_state.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

function sidOf(s: Scenario): string {
  return (s as unknown as { sessionId: string }).sessionId
}
async function effectivePT(s: Scenario, card: string): Promise<{ p: number; t: number }> {
  const r = await s.client.query<{ p: number; t: number }>(
    'select public.card_effective_power($1, $2) as p, public.card_effective_toughness($1, $2) as t',
    [sidOf(s), card],
  )
  return { p: Number(r.rows[0]!.p), t: Number(r.rows[0]!.t) }
}
async function cardBag(s: Scenario, card: string): Promise<Record<string, number>> {
  const r = await s.client.query<{ counters: Record<string, number> }>('select counters from public.game_cards where id = $1', [card])
  return r.rows[0]?.counters ?? {}
}

// MM1 — a −1/−1 counter lowers effective power and toughness.
test('MM1 a -1/-1 counter lowers P/T', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bear = await s.spawnCreature('A', 'Air Elemental Test') // 4/4
    assert.deepEqual(await effectivePT(s, bear), { p: 4, t: 4 })

    await s.as('A').castSpellEffect([{ type: 'add_counters', amount: 1, counter_type: 'minus_one_one' }], bear)
    await s.as('A').resolveStack()

    assert.deepEqual(await effectivePT(s, bear), { p: 3, t: 3 })
    assert.equal((await cardBag(s, bear)).minus_one_one, 1)
  })
})

// MM2 — a −1/−1 counter that drops a 1/1 to 0 toughness kills it (recheck SBA).
test('MM2 a -1/-1 counter to 0 toughness kills', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const x = await s.spawnCreature('A', 'Deathtouch Viper Test') // 1/1

    await s.as('A').castSpellEffect([{ type: 'add_counters', amount: 1, counter_type: 'minus_one_one' }], x)
    await s.as('A').resolveStack()

    assert.equal(await s.zoneOf(x), 'graveyard')
  })
})

// MM3 — +1/+1 and −1/−1 annihilate in pairs (CR 122.3).
test('MM3 +1/+1 and -1/-1 counters annihilate', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bear = await s.spawnCreature('A', 'Air Elemental Test') // 4/4
    await s.client.query('update public.game_cards set plus_one_counters = 2 where id = $1', [bear])

    // Add 3 −1/−1: least(2,3)=2 annihilate → 0 plus_one, 1 minus_one remaining.
    await s.as('A').castSpellEffect([{ type: 'add_counters', amount: 3, counter_type: 'minus_one_one' }], bear)
    await s.as('A').resolveStack()

    const st = await s.cardState(bear)
    assert.equal(st.plus_one_counters, 0)
    assert.equal((await cardBag(s, bear)).minus_one_one, 1)
    assert.deepEqual(await effectivePT(s, bear), { p: 3, t: 3 }) // 4/4 net -1/-1
  })
})

// MM4 — proliferate bumps a −1/−1 counter (it rides the bag like any other counter).
test('MM4 proliferate bumps a -1/-1 counter', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bear = await s.spawnCreature('A', 'Air Elemental Test') // 4/4
    await s.client.query(`update public.game_cards set counters = '{"minus_one_one":1}'::jsonb where id = $1`, [bear])

    await s.as('A').castSpellEffect([{ type: 'proliferate' }])
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { chosen: [bear] })

    assert.equal((await cardBag(s, bear)).minus_one_one, 2)
    assert.deepEqual(await effectivePT(s, bear), { p: 2, t: 2 }) // 4/4 net -2/-2
  })
})

// MM5 — adding +1/+1 onto a −1/−1 creature also annihilates (regardless of which
// counter was the one just added).
test('MM5 adding +1/+1 onto a -1/-1 creature annihilates', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bear = await s.spawnCreature('A', 'Air Elemental Test') // 4/4
    await s.client.query(`update public.game_cards set counters = '{"minus_one_one":2}'::jsonb where id = $1`, [bear])

    // Add three +1/+1 (default counter_type): least(3,2)=2 annihilate → +1 net.
    await s.as('A').castSpellEffect([{ type: 'add_counters', amount: 3 }], bear)
    await s.as('A').resolveStack()

    const st = await s.cardState(bear)
    assert.equal(st.plus_one_counters, 1)
    assert.equal((await cardBag(s, bear)).minus_one_one ?? 0, 0)
    assert.deepEqual(await effectivePT(s, bear), { p: 5, t: 5 }) // 4/4 net +1/+1
  })
})
