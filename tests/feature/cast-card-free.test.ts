import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx, asPlayer } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => { await ensureTestCards() })

// The no-target spell path calls cast_spell_effect, which gates on auth.uid()
// (priority player + card ownership) — a raw client.query call must set that
// context itself via asPlayer (Scenario.as() only records the acting seat for
// its own helper methods; see free-cast-flag.test.ts for the same pattern).
async function castFree(s: Scenario, cardId: string) {
  const playerId = s.playerId('A')
  return asPlayer(s.client, playerId, () =>
    s.client.query(`select public.cast_card_free($1, $2, $3) as decision_id`,
      [s.sessionId, cardId, playerId]))
}

test('CF1 free-casts a permanent from exile onto the battlefield', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bear = await s.spawn('A', 'Cascade Bear Test', 'exile')
    await s.as('A')
    await castFree(s, bear)
    // pushed as a cast_permanent stack item; resolve it to the battlefield
    await s.as('A').resolveStack()
    assert.equal(await s.zoneOf(bear), 'battlefield')
  })
})

test('CF2 free-casts a no-target sorcery from exile; it resolves and goes to graveyard', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    // give A a library card to draw
    await s.spawn('A', 'Grave Shambler Test', 'library')
    const draw = await s.spawn('A', 'Cascade Draw Test', 'exile')
    await s.as('A')
    await castFree(s, draw)
    await s.as('A').resolveStack() // resolves the spell_effect
    assert.equal(await s.zoneOf(draw), 'graveyard')
    assert.equal(await s.zoneCount('A', 'hand'), 1)
  })
})
