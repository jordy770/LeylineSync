// mig 372 — Alphinaud's Eukrasia: "Whenever you cast your SECOND spell each turn,
// draw a card." A `spell_number` filter on the spell_cast watcher fires only on the
// Nth cast of the turn (reusing the spells_cast_this_turn counter, mig 369). Each
// Eukrasia draw moves one card library→hand, so the library count isolates it.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

test('SS1 Eukrasia draws on the second spell of the turn only', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A', turnNumber: 4 })
    await s.spawnCreature('A', 'Alphinaud Test')
    for (let i = 0; i < 6; i++) await s.spawn('A', 'Scry Seer Test', 'library') // draw fuel

    const s1 = await s.spawn('A', 'Dino Grunt Test', 'hand')
    const s2 = await s.spawn('A', 'Goblin Raider Test', 'hand')
    const s3 = await s.spawn('A', 'Air Elemental Test', 'hand')

    const lib = () => s.zoneCount('A', 'library')
    const fund = () => s.setMana('A', { W: 5, U: 5, B: 5, R: 5, G: 5, C: 5 })
    const stackCount = async (): Promise<number> => {
      const r = await s.client.query<{ n: number }>(
        `select count(*)::int n from public.game_stack_items where session_id = $1 and status = 'pending'`,
        [s.sessionId],
      )
      return r.rows[0].n
    }
    // The 2nd spell stacks its Eukrasia trigger on top of the spell, so drain fully.
    const drain = async () => { let g = 0; while ((await stackCount()) > 0 && g++ < 10) await s.as('A').resolveStack() }
    const L0 = await lib()

    await fund(); await s.as('A').castPermanent(s1); await drain()
    assert.equal(await lib(), L0) // 1st spell — no Eukrasia draw

    await fund(); await s.as('A').castPermanent(s2); await drain()
    assert.equal(await lib(), L0 - 1) // 2nd spell — Eukrasia draws exactly one

    await fund(); await s.as('A').castPermanent(s3); await drain()
    assert.equal(await lib(), L0 - 1) // 3rd spell — no further draw
  })
})
