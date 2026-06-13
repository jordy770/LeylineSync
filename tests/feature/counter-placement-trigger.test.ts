// Counter-placement trigger event (roadmap Tribal #3). `creature_got_counter` fires
// (via fire_counter_triggers → fire_watcher_triggers) whenever a creature's +1/+1
// counter total INCREASES. Reuses the watcher filter (type_line / controller /
// exclude_self) and self-inclusion.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function pending(s: Scenario): Promise<number> {
  const r = await s.client.query<{ n: string }>(
    "select count(*) as n from public.game_stack_items where session_id = $1 and status <> 'resolved'",
    [s.sessionId],
  )
  return Number(r.rows[0]!.n)
}

// CT1 — putting a +1/+1 counter on another of your creatures fires the watcher (draw).
test('CT1 fires when a creature you control gets a +1/+1 counter', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Counter Reactor Test')
    const target = await s.spawnCreature('A', 'Grave Shambler Test')
    await s.spawn('A', 'Air Elemental Test', 'library')
    const handBefore = await s.zoneCount('A', 'hand')

    await s.as('A').putOnStack('add_counters_creature', { target_card_id: target, amount: 1, target_controller: 'any' })
    await s.as('A').resolveStack() // counter lands → got_counter trigger enqueues the draw
    await s.as('A').resolveStack() // the draw resolves

    assert.equal((await s.cardState(target)).plus_one_counters, 1)
    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 1)
  })
})

// CT2 — the watcher fires on its OWN counter (no exclude_self).
test('CT2 fires when the watcher itself gets a counter', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const reactor = await s.spawnCreature('A', 'Counter Reactor Test')
    await s.spawn('A', 'Air Elemental Test', 'library')
    const handBefore = await s.zoneCount('A', 'hand')

    await s.as('A').putOnStack('add_counters_creature', { target_card_id: reactor, amount: 1, target_controller: 'any' })
    await s.as('A').resolveStack()
    await s.as('A').resolveStack()

    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 1)
  })
})

// CT3 — an opponent's creature getting a counter does NOT fire a "you control" watcher.
test('CT3 controller filter ignores an opponent\'s counter', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Counter Reactor Test')
    const theirs = await s.spawnCreature('B', 'Grave Shambler Test')

    await s.as('A').putOnStack('add_counters_creature', { target_card_id: theirs, amount: 1, target_controller: 'any' })
    await s.as('A').resolveStack() // counter lands on the opponent's creature
    assert.equal(await pending(s), 0) // "you control" watcher does NOT fire
  })
})

// CT4 — removing/annihilating counters (a DECREASE) does not fire.
test('CT4 a counter decrease does not fire', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    // Pre-load counters BEFORE the watcher is on the board (a direct increase would
    // otherwise fire the trigger itself).
    const target = await s.spawnCreature('A', 'Grave Shambler Test')
    await s.client.query('update public.game_cards set plus_one_counters = 2 where id = $1', [target])
    await s.spawnCreature('A', 'Counter Reactor Test')

    await s.as('A').putOnStack('add_counters_creature', { target_card_id: target, amount: -1, target_controller: 'any' })
    await s.as('A').resolveStack() // removes one counter
    assert.equal(await pending(s), 0) // a decrease is not "getting" a counter
    assert.equal((await s.cardState(target)).plus_one_counters, 1)
  })
})
