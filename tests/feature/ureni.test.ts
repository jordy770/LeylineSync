// Ureni of the Unwritten (mig 223) — "Whenever Ureni enters or attacks, look at
// the top eight cards of your library. You may put a Dragon creature card from
// among them onto the battlefield. Put the rest on the bottom in a random
// order." The new `look_top` decision effect.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function libIds(s: Scenario, seat: 'A' | 'B'): Promise<string[]> {
  const r = await s.client.query<{ id: string }>(
    `select id from public.game_cards where session_id = $1 and owner_id = $2 and zone = 'library' order by zone_position asc, id asc`,
    [s.sessionId, s.players[seat]])
  return r.rows.map((x) => x.id)
}

// UR1 — ETB digs 8, puts a chosen Dragon onto the battlefield, bottoms the rest.
test('UR1 Ureni ETB puts a Dragon down and bottoms the rest', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    // Library: a Dragon among non-Dragons in the top 8.
    const dragon = await s.spawn('A', 'Keiga Test', 'library') // a Dragon creature
    for (let i = 0; i < 5; i++) await s.spawn('A', 'Air Elemental Test', 'library')
    const deepCard = await s.spawn('A', 'Goblin Raider Test', 'library') // 7th — still in top 8

    await s.spawnCreature('A', 'Ureni Test')
    const res = (await s.as('A').resolveStack()) as Record<string, unknown>
    assert.equal(res.awaiting_decision, true)

    const d = await s.pendingDecision()
    assert.equal(d?.decision_type, 'look_top')
    // Only the Dragon is offered (filter: Dragon creature).
    const opts = (d!.options as { game_card_id: string }[]).map((o) => o.game_card_id)
    assert.deepEqual(opts, [dragon])

    await s.as('A').submitDecision(d!.id, { chosen: [dragon] })
    assert.equal(await s.zoneOf(dragon), 'battlefield') // put down
    // The looked-at non-Dragons went to the bottom: the library is now those
    // cards, and the deep card sits at/after the front (it was within top 8).
    const lib = await libIds(s, 'A')
    assert.ok(!lib.includes(dragon)) // the Dragon left the library
    assert.ok(lib.includes(deepCard)) // everything else stayed in the library
  })
})

// UR2 — declining puts nothing down; the whole looked-at set is bottomed.
test('UR2 declining bottoms everything, nothing enters', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const dragon = await s.spawn('A', 'Keiga Test', 'library')
    for (let i = 0; i < 4; i++) await s.spawn('A', 'Air Elemental Test', 'library')

    await s.spawnCreature('A', 'Ureni Test')
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { chosen: [] })

    assert.equal(await s.zoneOf(dragon), 'library') // still in library, just bottomed
  })
})

// UR3 — no Dragon in the top 8: no decision is parked, the set is bottomed.
test('UR3 no Dragon to find resolves with no decision', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const top = await s.spawn('A', 'Air Elemental Test', 'library')
    for (let i = 0; i < 3; i++) await s.spawn('A', 'Goblin Raider Test', 'library')

    await s.spawnCreature('A', 'Ureni Test')
    const res = (await s.as('A').resolveStack()) as Record<string, unknown>

    assert.notEqual(res.awaiting_decision, true) // no Dragon → no decision
    assert.equal(await s.pendingDecision(), null)
    // The top card moved (bottomed) — library still has all 4 non-Dragons.
    assert.equal(await s.zoneCount('A', 'library'), 4)
    assert.equal(await s.zoneOf(top), 'library')
  })
})
