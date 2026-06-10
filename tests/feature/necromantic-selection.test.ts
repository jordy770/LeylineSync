// Necromantic Selection (mig 208) — "Destroy all creatures, then return a
// creature card put into a graveyard this way to the battlefield under your
// control." mass_destroy_reanimate_one wipes the board (indestructible
// survives), then parks a single pick over the died set; the chosen card comes
// back under the CASTER's control (ownership unchanged).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

async function controllerOf(s: Scenario, cardId: string): Promise<string> {
  const r = await s.client.query<{ c: string }>(
    `select coalesce(controller_player_id, owner_id) as c from public.game_cards where id = $1`,
    [cardId],
  )
  return r.rows[0]!.c
}

// NS1 — wipe, then steal: A reanimates B's creature under A's control.
test('NS1 destroy all, return an opponent creature under your control', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const mine = await s.spawnCreature('A', 'Goblin Raider Test')
    const theirs = await s.spawnCreature('B', 'Grave Shambler Test')

    await s.as('A').castSpellEffect([{ type: 'mass_destroy_reanimate_one' }])
    const res = (await s.as('A').resolveStack()) as Record<string, unknown>
    assert.equal(res.awaiting_decision, true)

    // Everything died first.
    assert.equal(await s.zoneOf(mine), 'graveyard')
    assert.equal(await s.zoneOf(theirs), 'graveyard')

    const d = await s.pendingDecision()
    assert.equal(d?.decision_type, 'reanimate_destroyed')
    assert.equal((d!.options as unknown[]).length, 2) // both died cards offered

    await s.as('A').submitDecision(d!.id, { chosen: [theirs] })
    assert.equal(await s.zoneOf(theirs), 'battlefield')
    assert.equal(await controllerOf(s, theirs), s.playerId('A')) // stolen
    assert.equal(await s.zoneOf(mine), 'graveyard') // the other stays dead
  })
})

// NS2 — declining the return ("up to one"): everything stays dead and the
// spell finishes resolving.
test('NS2 declining the return leaves the board empty', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const fragile = await s.spawnCreature('B', 'Goblin Raider Test')

    await s.as('A').castSpellEffect([{ type: 'mass_destroy_reanimate_one' }])
    await s.as('A').resolveStack()

    const d = await s.pendingDecision()
    assert.equal((d!.options as unknown[]).length, 1)
    await s.as('A').submitDecision(d!.id, { chosen: [] })

    assert.equal(await s.zoneOf(fragile), 'graveyard')
    assert.equal(await s.pendingDecision(), null) // finished
  })
})
