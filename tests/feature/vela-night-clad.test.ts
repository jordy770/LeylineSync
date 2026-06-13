// Vela the Night-Clad (mig 201) — "Intimidate. Other creatures you control have
// intimidate. Whenever Vela or another creature you control leaves the
// battlefield, each opponent loses 1 life." The new `creature_left` watcher event
// fires on ANY battlefield→elsewhere move (death, exile, bounce), and the
// intimidate anthem uses the mig 200 exclude_source keyword-grant filter.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx, asPlayer } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function hasIntimidate(s: Scenario, seat: 'A' | 'B', cardId: string): Promise<boolean> {
  return asPlayer(s.client, s.players[seat], async () => {
    const r = await s.client.query<{ r: boolean }>(
      'select public.card_has_intimidate($1, $2) as r',
      [s.sessionId, cardId],
    )
    return r.rows[0]!.r
  })
}

// VN1 — the anthem: Vela (intrinsic) + your OTHER creatures have intimidate;
// the grant skips opponents' creatures.
test('VN1 Vela grants intimidate to your other creatures', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const vela = await s.spawnCreature('A', 'Vela the Night-Clad Test')
    const mine = await s.spawnCreature('A', 'Goblin Raider Test')
    const theirs = await s.spawnCreature('B', 'Goblin Raider Test')
    await s.as('A').rebuild()

    assert.equal(await hasIntimidate(s, 'A', vela), true) // intrinsic
    assert.equal(await hasIntimidate(s, 'A', mine), true) // granted
    assert.equal(await hasIntimidate(s, 'B', theirs), false)
  })
})

// VN2 — a creature you control DYING fires the leave trigger: each opponent loses 1.
test('VN2 your creature dying drains each opponent', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Vela the Night-Clad Test')
    const victim = await s.spawnCreature('A', 'Goblin Raider Test')
    await s.as('A').rebuild()
    const before = await s.lifeOf('B')

    await s.as('A').putOnStack('destroy_creature', { target_card_id: victim, target_controller: 'any' })
    await s.as('A').resolveStack() // destroy resolves; watcher trigger enqueued
    await s.as('A').resolveStack() // the lose_life trigger resolves

    assert.equal(await s.lifeOf('B'), before - 1)
  })
})

// VN3 — a BOUNCE also fires it (leaves ≠ dies): that's why the card needs
// creature_left, not creature_died.
test('VN3 bounce fires the leave trigger too', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.spawnCreature('A', 'Vela the Night-Clad Test')
    const bounced = await s.spawnCreature('A', 'Goblin Raider Test')
    await s.as('A').rebuild()
    const before = await s.lifeOf('B')

    await s.as('A').putOnStack('bounce_creature', { target_card_id: bounced, target_controller: 'any' })
    await s.as('A').resolveStack()
    await s.as('A').resolveStack()

    assert.equal(await s.lifeOf('B'), before - 1)
  })
})

// VN4 — Vela herself leaving fires her own trigger (self-inclusion), and an
// OPPONENT's creature leaving does not.
test('VN4 Vela watches her own departure; opponents are ignored', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const vela = await s.spawnCreature('A', 'Vela the Night-Clad Test')
    const theirs = await s.spawnCreature('B', 'Goblin Raider Test')
    await s.as('A').rebuild()
    const before = await s.lifeOf('B')

    // An opponent's creature dying does NOT fire ("you control" filter).
    await s.as('A').putOnStack('destroy_creature', { target_card_id: theirs, target_controller: 'any' })
    await s.as('A').resolveStack()
    assert.equal(await s.lifeOf('B'), before)

    // Vela dying fires her own leave trigger.
    await s.as('A').putOnStack('destroy_creature', { target_card_id: vela, target_controller: 'any' })
    await s.as('A').resolveStack()
    await s.as('A').resolveStack()
    assert.equal(await s.lifeOf('B'), before - 1)
  })
})
