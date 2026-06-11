// Zenith Festival — "Exile the top X cards of your library. You may play
// them until the end of your next turn." NO engine change: cast_spell_effect
// already substitutes a top-level count 'X' (mig 109) and impulse (mig 230)
// does the rest. Harmonize (cast from graveyard for {X}{R}{R} with the
// tap-a-creature reduction) is NOT modelled.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// ZF1 — X=2 exiles exactly two and grants the play window for both.
test('ZF1 Zenith Festival impulses X cards', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    for (let i = 0; i < 3; i++) await s.spawn('A', 'Wastes Test', 'library')

    await s.as('A').castSpellEffect([{ type: 'impulse', count: 'X' }], null, 2)
    await s.as('A').resolveStack()

    const exiled = await s.client.query<{ n: string }>(
      `select count(*)::int as n from public.game_cards
       where session_id = $1 and owner_id = $2 and zone = 'exile'`,
      [s.sessionId, s.players.A])
    assert.equal(Number(exiled.rows[0]!.n), 2)
    const perm = await s.client.query<{ payload: { card_ids: string[] } }>(
      `select payload from public.game_continuous_effects
       where session_id = $1 and effect_type = 'play_from_exile' and affected_player_id = $2`,
      [s.sessionId, s.players.A])
    assert.equal(perm.rows.length, 1)
    assert.equal(perm.rows[0]!.payload.card_ids.length, 2)
  })
})
