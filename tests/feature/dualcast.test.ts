// mig 369 — Alisaie Leveilleur, Dualcast: "The second spell you cast each turn
// costs {2} less to cast." A turn-stamped per-player spell tally (note_spell_cast,
// fired from fire_watcher_triggers on 'spell_cast') drives an nth_spell condition
// on the static cost_reduction in reduced_mana_cost.

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
    [s.sessionId, s.playerId(seat)],
  )
  return r.rows[0]?.mana_pool ?? {}
}

async function spellsCast(s: Scenario, seat: 'A' | 'B'): Promise<number> {
  const r = await s.client.query<{ n: number }>(
    `select public.resolve_count_amount($1, $2, '{"count":"spells_cast_this_turn"}'::jsonb) as n`,
    [s.sessionId, s.playerId(seat)],
  )
  return r.rows[0].n
}

// AL1 — only the SECOND spell of the turn gets the -{2}; the 1st and 3rd pay full.
test('AL1 Dualcast reduces only the second spell each turn', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A', turnNumber: 5 })
    await s.spawnCreature('A', 'Alisaie Test') // registers the cost_reduction
    await s.as('A').rebuild()
    const spell = await s.spawn('A', 'Dino Grunt Test', 'hand') // {2}{G}
    const A = s.playerId('A')

    const costNow = async (): Promise<string> => {
      const r = await client.query<{ c: string }>(
        'select public.reduced_mana_cost($1, $2, $3, $4) as c',
        [s.sessionId, A, spell, '{2}{G}'],
      )
      return r.rows[0].c
    }
    const setCastCount = async (n: number) => {
      await client.query(
        'update public.game_session_players set turn_spells_cast = $1, turn_spells_cast_turn = 5 where session_id = $2 and player_id = $3',
        [n, s.sessionId, A],
      )
    }

    await setCastCount(0)
    assert.equal(await costNow(), '{2}{G}') // 1st spell — full price
    await setCastCount(1)
    assert.equal(await costNow(), '{G}') // 2nd spell — {2} cheaper
    await setCastCount(2)
    assert.equal(await costNow(), '{2}{G}') // 3rd spell — full again
  })
})

// AL2 — the tally accumulates via note_spell_cast and lazily resets next turn.
test('AL2 spells_cast_this_turn counts casts and resets each turn', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A', turnNumber: 5 })
    const A = s.playerId('A')
    const count = async (): Promise<number> => {
      const r = await client.query<{ n: number }>(
        `select public.resolve_count_amount($1, $2, '{"count":"spells_cast_this_turn"}'::jsonb) as n`,
        [s.sessionId, A],
      )
      return r.rows[0].n
    }

    assert.equal(await count(), 0)
    await client.query('select public.note_spell_cast($1, $2)', [s.sessionId, A])
    await client.query('select public.note_spell_cast($1, $2)', [s.sessionId, A])
    assert.equal(await count(), 2)

    // Next turn: the stamp goes stale, so the count lazily resets to 0.
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A', turnNumber: 6 })
    assert.equal(await count(), 0)
  })
})

// AL3 — end-to-end via real casts: casting Alisaie HERSELF is the turn's first
// spell, so the counter is at 1 immediately and the very next spell is discounted.
test('AL3 casting Alisaie makes the next spell the discounted second', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A', turnNumber: 3 })
    const alisaie = await s.spawn('A', 'Alisaie Test', 'hand') // {2}{W}

    assert.equal(await spellsCast(s, 'A'), 0)

    // Cast Alisaie (full price — her own static doesn't help her own cast).
    await s.setMana('A', { C: 2, W: 1 })
    await s.as('A').castPermanent(alisaie)
    assert.equal(await spellsCast(s, 'A'), 1) // counter is at 1 right after playing her
    await s.as('A').resolveStack() // she enters → Dualcast registers

    // The next spell is the SECOND this turn → {2}{G} costs {G}. Fund only {G};
    // the cast succeeds only because the {2} discount applied.
    const spell = await s.spawn('A', 'Dino Grunt Test', 'hand') // {2}{G}
    await s.setMana('A', { G: 1 })
    await s.as('A').castPermanent(spell)
    assert.deepEqual(await pool(s, 'A'), { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 })
    assert.equal(await spellsCast(s, 'A'), 2)
  })
})
