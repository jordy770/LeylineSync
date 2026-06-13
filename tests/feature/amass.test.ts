// Amass N (mig 182) — "If you don't control an Army, create a 0/0 black Zombie
// Army token. Then put N +1/+1 counters on an Army you control." Multiple amass
// effects grow the SAME Army; the 0/0 survives because counters land atomically.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// Armies (type_line ~ 'Army') a seat controls, with their +1/+1 counters.
async function armies(s: Scenario, seat: 'A' | 'B'): Promise<{ id: string; counters: number }[]> {
  const r = await s.client.query<{ id: string; plus_one_counters: number }>(
    `select gc.id, gc.plus_one_counters from public.game_cards gc
     join public.cards c on c.id = gc.card_id
     where gc.session_id = $1 and gc.controller_player_id = $2 and gc.zone = 'battlefield'
       and c.type_line ilike '%Army%'`,
    [s.sessionId, s.players[seat]],
  )
  return r.rows.map((row) => ({ id: row.id, counters: Number(row.plus_one_counters) }))
}

// AM1 — amass with no Army creates a 0/0 Zombie Army and puts N counters on it.
test('AM1 amass creates an Army and adds counters', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    await s.as('A').castSpellEffect([{ type: 'amass', amount: 2 }])
    await s.as('A').resolveStack()

    const army = await armies(s, 'A')
    assert.equal(army.length, 1) // one Army token created
    assert.equal(army[0]!.counters, 2) // 0/0 + 2 counters = 2/2
    assert.equal(await s.effectivePower(army[0]!.id), 2)
    assert.equal(await s.effectiveToughness(army[0]!.id), 2)
  })
})

// AM2 — a second amass grows the SAME Army (you don't make a second one).
test('AM2 a second amass grows the same Army', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    await s.as('A').castSpellEffect([{ type: 'amass', amount: 2 }])
    await s.as('A').resolveStack()
    await s.as('A').castSpellEffect([{ type: 'amass', amount: 1 }])
    await s.as('A').resolveStack()

    const army = await armies(s, 'A')
    assert.equal(army.length, 1) // still ONE Army
    assert.equal(army[0]!.counters, 3) // 2 + 1
  })
})

// AM3 — amass as an ETB trigger (Lazotep Reaver) creates a 1/1 Army.
test('AM3 amass works from an enters-the-battlefield trigger', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })

    await s.spawnCreature('A', 'Lazotep Reaver Test') // ETB: amass 1
    await s.as('A').resolveStack()

    const army = await armies(s, 'A')
    assert.equal(army.length, 1)
    assert.equal(army[0]!.counters, 1)
  })
})
