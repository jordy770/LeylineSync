// Commander (EDH) — zone-return flow. Mig 142 built the silent redirect; mig 374
// made the graveyard/exile path a PER-EVENT DECISION (CR 903.9a): the commander
// really lands in the graveyard/exile (dies/leaves triggers fire), then a
// 'commander_zone_return' decision is parked for the owner — Yes moves it to
// the command zone, No leaves it. Hand/library (903.9b) stay a silent redirect
// honouring the commander_redirect preference.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// RC1 — a dying commander lands in the graveyard and parks the owner's decision;
// confirming moves it to the command zone.
test('RC1 a dying commander parks a decision; Yes returns it to the command zone', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 2, { format: 'commander' })
    const cmd = await s.spawnCommander('A', 'Goblin Raider Test', 'battlefield')

    await s.as('A').putInGraveyard(cmd)

    assert.equal(await s.zoneOf(cmd), 'graveyard') // it really died (903.9a)
    const d = await s.pendingDecision()
    assert.equal(d?.decision_type, 'commander_zone_return')
    assert.equal(d?.deciding_player_id, s.playerId('A'))

    await s.as('A').submitDecision(d!.id, { confirmed: true })
    assert.equal(await s.zoneOf(cmd), 'command')
  })
})

// RC2 — an EXILED commander parks the same decision.
test('RC2 an exiled commander parks a decision; Yes returns it to the command zone', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 2, { format: 'commander' })
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const cmd = await s.spawnCommander('A', 'Goblin Raider Test', 'battlefield')

    await s.as('A').putOnStack('exile_creature', { target_card_id: cmd })
    await s.resolveStack()

    assert.equal(await s.zoneOf(cmd), 'exile')
    const d = await s.pendingDecision()
    assert.equal(d?.decision_type, 'commander_zone_return')

    await s.as('A').submitDecision(d!.id, { confirmed: true })
    assert.equal(await s.zoneOf(cmd), 'command')
  })
})

// RC3 — a BOUNCED commander still silently redirects to the command zone
// (hand/library are a true replacement, CR 903.9b — no decision).
test('RC3 a bounced commander returns to the command zone without a decision', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 2, { format: 'commander' })
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const cmd = await s.spawnCommander('A', 'Goblin Raider Test', 'battlefield')

    await s.as('A').putOnStack('bounce_creature', { target_card_id: cmd })
    await s.resolveStack()

    assert.equal(await s.zoneOf(cmd), 'command')
    assert.equal(await s.zoneCount('A', 'hand'), 0)
    assert.equal(await s.pendingDecision(), null)
  })
})

// RC4 — declining the decision leaves the commander in the graveyard (reanimator).
test('RC4 declining leaves the commander in the graveyard', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 2, { format: 'commander' })
    const cmd = await s.spawnCommander('A', 'Goblin Raider Test', 'battlefield')

    await s.as('A').putInGraveyard(cmd)
    const d = await s.pendingDecision()

    await s.as('A').submitDecision(d!.id, { confirmed: false })
    assert.equal(await s.zoneOf(cmd), 'graveyard')
    assert.equal(await s.pendingDecision(), null)
  })
})

// RC5 — the 'dies' trigger FIRES even when the commander then returns
// (rules-accurate since mig 374; mig 142 wrongly suppressed it on redirect).
test('RC5 the dies trigger fires and the commander can still return', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 2, { format: 'commander' })
    const cmd = await s.spawnCommander('A', 'Reaper Commander Test', 'battlefield')

    await s.as('A').putInGraveyard(cmd)

    assert.equal(await s.pendingCount(), 1) // "when this dies, draw" IS on the stack
    const d = await s.pendingDecision()
    await s.as('A').submitDecision(d!.id, { confirmed: true })
    assert.equal(await s.zoneOf(cmd), 'command')
    assert.equal(await s.pendingCount(), 1) // returning doesn't eat the trigger
  })
})

// RC6 — the hand/library preference still works: opting out sends a bounced
// commander to the HAND instead of the command zone.
test('RC6 opting out routes a bounced commander to the hand', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 2, { format: 'commander' })
    await s.as('A').setCommanderRedirect('A', false)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const cmd = await s.spawnCommander('A', 'Goblin Raider Test', 'battlefield')

    await s.as('A').putOnStack('bounce_creature', { target_card_id: cmd })
    await s.resolveStack()

    assert.equal(await s.zoneOf(cmd), 'hand')
    assert.equal(await s.pendingDecision(), null) // hand path never parks a decision
  })
})
