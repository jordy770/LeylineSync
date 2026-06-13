// Other-scoped trigger events (roadmap Tribal #1, second half). `creature_entered` /
// `creature_died` triggers watch OTHER permanents (filtered by type_line / controller /
// exclude_self), broadcast by fire_watcher_triggers. The watcher's effects act on the
// watcher itself. A dying creature can watch its OWN death (Midnight Reaper).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// Pending (unresolved) stack items — 0 means nothing triggered.
async function pending(s: Scenario): Promise<number> {
  const r = await s.client.query<{ n: string }>(
    "select count(*) as n from public.game_stack_items where session_id = $1 and status <> 'resolved'",
    [s.sessionId],
  )
  return Number(r.rows[0]!.n)
}

// WT1 — "Whenever another Zombie you control enters, put a +1/+1 counter on ~".
test('WT1 typed enter-watcher counts only your OTHER Zombies', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const champ = await s.spawnCreature('A', 'Champion Watcher Test')
    assert.equal((await s.cardState(champ)).plus_one_counters, 0) // exclude_self: its own ETB doesn't count

    await s.spawnCreature('A', 'Grave Shambler Test') // a Zombie you control
    assert.equal(await pending(s), 1) // the watcher triggered
    await s.as('A').resolveStack()
    assert.equal((await s.cardState(champ)).plus_one_counters, 1)

    await s.spawnCreature('A', 'Goblin Raider Test') // not a Zombie
    assert.equal(await pending(s), 0) // no trigger
    assert.equal((await s.cardState(champ)).plus_one_counters, 1)

    await s.spawnCreature('B', 'Grave Shambler Test') // opponent's Zombie
    assert.equal(await pending(s), 0) // controller filter — no trigger
    assert.equal((await s.cardState(champ)).plus_one_counters, 1)
  })
})

// WT2 — "Whenever a creature you control dies, you draw a card" (another creature).
test('WT2 death-watcher fires when another of your creatures dies', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Reaper Watcher Test')
    const victim = await s.spawnCreature('A', 'Grave Shambler Test')
    await s.spawn('A', 'Air Elemental Test', 'library')
    const handBefore = await s.zoneCount('A', 'hand')

    await s.as('A').putOnStack('destroy_creature', { target_card_id: victim, target_controller: 'any' })
    await s.as('A').resolveStack() // destroy → death broadcast enqueues the draw
    await s.as('A').resolveStack() // the draw resolves

    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 1)
  })
})

// WT3 — the watcher fires on its OWN death (Midnight Reaper; no exclude_self).
test('WT3 death-watcher fires on its own death', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const reaper = await s.spawnCreature('A', 'Reaper Watcher Test')
    await s.spawn('A', 'Air Elemental Test', 'library')
    const handBefore = await s.zoneCount('A', 'hand')

    await s.as('A').putOnStack('destroy_creature', { target_card_id: reaper, target_controller: 'any' })
    await s.as('A').resolveStack() // reaper dies → it watches its own death
    await s.as('A').resolveStack() // the draw resolves

    assert.equal(await s.zoneCount('A', 'hand'), handBefore + 1)
  })
})

// WT4 — aristocrat payoff: your creature dying drains each opponent.
test('WT4 death-watcher drains each opponent', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Vengeful Watcher Test')
    const victim = await s.spawnCreature('A', 'Grave Shambler Test')
    const bBefore = await s.lifeOf('B')

    await s.as('A').putOnStack('destroy_creature', { target_card_id: victim, target_controller: 'any' })
    await s.as('A').resolveStack()
    await s.as('A').resolveStack()

    assert.equal(await s.lifeOf('B'), bBefore - 1)
  })
})

// WT5 — an opponent's creature dying does NOT fire a "you control" death-watcher.
test('WT5 controller filter ignores an opponent\'s creature dying', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Reaper Watcher Test')
    const theirs = await s.spawnCreature('B', 'Grave Shambler Test')
    await s.spawn('A', 'Air Elemental Test', 'library')
    const handBefore = await s.zoneCount('A', 'hand')

    await s.as('A').putOnStack('destroy_creature', { target_card_id: theirs, target_controller: 'any' })
    await s.as('A').resolveStack() // destroys; the "you control" watcher does NOT fire
    assert.equal(await pending(s), 0) // nothing enqueued
    assert.equal(await s.zoneCount('A', 'hand'), handBefore) // opponent's creature — no draw
  })
})
