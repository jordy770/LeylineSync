// Commander (EDH) — return-to-command refinements (mig 142). A commander leaving
// the battlefield to graveyard/exile/hand/library returns to the command zone
// instead (CR 903.9), honouring the owner's standing preference. A redirect
// suppresses the false 'dies' trigger; opting out lets the commander die normally.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// RC1 — a commander dying from the battlefield returns to the command zone.
test('RC1 a dying commander returns to the command zone', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 2, { format: 'commander' })
    const cmd = await s.spawnCommander('A', 'Goblin Raider Test', 'battlefield')

    await s.as('A').putInGraveyard(cmd)

    assert.equal(await s.zoneOf(cmd), 'command')
  })
})

// RC2 — an EXILED commander returns to the command zone (slice-1 gap: it was lost).
test('RC2 an exiled commander returns to the command zone', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 2, { format: 'commander' })
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const cmd = await s.spawnCommander('A', 'Goblin Raider Test', 'battlefield')

    await s.as('A').putOnStack('exile_creature', { target_card_id: cmd })
    await s.resolveStack()

    assert.equal(await s.zoneOf(cmd), 'command')
  })
})

// RC3 — a BOUNCED commander returns to the command zone (not the hand).
test('RC3 a bounced commander returns to the command zone', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 2, { format: 'commander' })
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const cmd = await s.spawnCommander('A', 'Goblin Raider Test', 'battlefield')

    await s.as('A').putOnStack('bounce_creature', { target_card_id: cmd })
    await s.resolveStack()

    assert.equal(await s.zoneOf(cmd), 'command')
    assert.equal(await s.zoneCount('A', 'hand'), 0)
  })
})

// RC4 — opting out: the commander goes to its natural zone (graveyard) instead.
test('RC4 opting out lets the commander go to the graveyard', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 2, { format: 'commander' })
    await s.as('A').setCommanderRedirect('A', false)
    const cmd = await s.spawnCommander('A', 'Goblin Raider Test', 'battlefield')

    await s.as('A').putInGraveyard(cmd)

    assert.equal(await s.zoneOf(cmd), 'graveyard')
  })
})

// RC5 — a redirect SUPPRESSES the false 'dies' trigger (the commander didn't die).
test('RC5 redirect suppresses the dies trigger', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 2, { format: 'commander' })
    const cmd = await s.spawnCommander('A', 'Reaper Commander Test', 'battlefield')

    await s.as('A').putInGraveyard(cmd)

    assert.equal(await s.zoneOf(cmd), 'command')
    assert.equal(await s.pendingCount(), 0) // "when this dies, draw" did NOT trigger
  })
})

// RC6 — opting out, the 'dies' trigger DOES fire (the commander really died).
test('RC6 the dies trigger fires when the commander is not redirected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 2, { format: 'commander' })
    await s.as('A').setCommanderRedirect('A', false)
    const cmd = await s.spawnCommander('A', 'Reaper Commander Test', 'battlefield')

    await s.as('A').putInGraveyard(cmd)

    assert.equal(await s.zoneOf(cmd), 'graveyard')
    assert.equal(await s.pendingCount(), 1) // the dies-draw trigger is on the stack
  })
})
