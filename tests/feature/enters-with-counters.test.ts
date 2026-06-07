// "Enters the battlefield with N counters" (roadmap Counters #3). A REPLACEMENT applied
// as the card enters (BEFORE state-based actions), so a 0/0 that enters with two +1/+1
// counters (Walking Ballista / Hangarback Walker) survives instead of dying to the
// 0-toughness SBA. Implemented as a BEFORE INSERT/UPDATE-of-zone trigger on game_cards.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function cardBag(s: Scenario, card: string): Promise<Record<string, number>> {
  const r = await s.client.query<{ counters: Record<string, number> }>('select counters from public.game_cards where id = $1', [card])
  return r.rows[0]?.counters ?? {}
}

// EWC1 — a 0/0 spawned directly onto the battlefield (INSERT) enters with its counters
// and survives (would otherwise be a dead 0/0).
test('EWC1 a 0/0 enters with two +1/+1 counters and survives', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const walker = await s.spawnCreature('A', 'Counter Walker Test') // base 0/0

    const st = await s.cardState(walker)
    assert.equal(st.zone, 'battlefield') // did NOT die to the 0-toughness SBA
    assert.equal(st.plus_one_counters, 2)
  })
})

// EWC2 — entering from another zone (e.g. reanimated from the graveyard) also applies
// the replacement (the UPDATE-of-zone path), overriding the plus_one_counters reset.
test('EWC2 entering from graveyard re-applies the counters', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const walker = await s.spawn('A', 'Counter Walker Test', 'graveyard')
    await client.query('update public.game_cards set plus_one_counters = 0 where id = $1', [walker])

    // Move it to the battlefield — the BEFORE-trigger sets the counters as it enters.
    await client.query("update public.game_cards set zone = 'battlefield', zone_position = 0 where id = $1", [walker])

    assert.equal((await s.cardState(walker)).plus_one_counters, 2)
  })
})

// EWC3 — a non-+1/+1 (bag) counter_type lands in the bag, not the fast column.
test('EWC3 enters_with_counters honors a bag counter_type', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const c = await s.spawn('A', 'Air Elemental Test', 'hand')
    await client.query(
      `update public.game_cards set copied_script = '{"schema_version":2,"enters_with_counters":{"amount":3,"counter_type":"charge"}}'::jsonb where id = $1`,
      [c],
    )

    await client.query("update public.game_cards set zone = 'battlefield', zone_position = 0 where id = $1", [c])

    assert.equal((await cardBag(s, c)).charge, 3)
    assert.equal((await s.cardState(c)).plus_one_counters, 0) // fast column untouched
  })
})

// EWC4 — a card NOT entering the battlefield (graveyard → hand) gets no counters.
test('EWC4 no counters when not entering the battlefield', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const walker = await s.spawn('A', 'Counter Walker Test', 'graveyard')

    await client.query("update public.game_cards set zone = 'hand', zone_position = 0 where id = $1", [walker])

    assert.equal((await s.cardState(walker)).plus_one_counters, 0)
  })
})
