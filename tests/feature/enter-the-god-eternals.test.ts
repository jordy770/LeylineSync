// Enter the God-Eternals — a multi-effect spell composed entirely from existing
// primitives: targeted deal_damage + you gain life + choose_player(mill) + amass.
// No new engine; this is an integration test that they resolve together (incl. the
// parked choose_player decision mid-program, then amass on resume).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// EGE1 — 4 damage kills the target, caster gains 4, chosen player mills 4, amass 4.
test('EGE1 resolves damage + lifegain + mill + amass together', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 2)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const victim = await s.spawnCreature('B', 'Vengeful Wall Test') // 0/4 — dies to 4
    for (let i = 0; i < 5; i++) await s.spawn('B', 'Grave Shambler Test', 'library')
    const lifeBefore = await s.lifeOf('A')
    const bGyBefore = await s.zoneCount('B', 'graveyard')

    await s.as('A').castSpellEffect([
      { type: 'deal_damage', amount: 4, target_type: 'creature' },
      { type: 'gain_life', amount: 4 },
      { type: 'choose_player', filter: 'any', effects: [{ type: 'mill', amount: 4 }] },
      { type: 'amass', amount: 4 },
    ], null, null, victim)
    await s.as('A').resolveStack() // damage + lifegain resolve, then choose_player parks

    const d = await s.pendingDecision()
    assert.equal(d?.decision_type, 'choose_player')
    await s.as('A').submitDecision(d!.id, { player_id: s.playerId('B') }) // mill B, then amass

    assert.equal(await s.zoneOf(victim), 'graveyard') // 4 damage killed it
    assert.equal(await s.lifeOf('A'), lifeBefore + 4) // gained life
    assert.equal(await s.zoneCount('B', 'graveyard'), bGyBefore + 1 + 4) // the wall + 4 milled

    // Amass 4: the caster gets a Zombie Army with four +1/+1 counters.
    const army = await s.client.query<{ c: number }>(
      `select coalesce(max(gc.plus_one_counters),0) as c from public.game_cards gc join public.cards c on c.id = gc.card_id
       where gc.session_id = $1 and gc.controller_player_id = $2 and gc.zone = 'battlefield' and c.type_line ilike '%Army%'`,
      [s.sessionId, s.players.A],
    )
    assert.equal(Number(army.rows[0]!.c), 4)
  })
})
