// Urianger Augurelt (mig 307): "Whenever you cast a spell from exile, you gain 2
// life." cast_card_from_hand / cast_spell_effect fire a cast_from_exile watcher
// event when the source was in exile. (Draw/Play Arcanum and the land-from-exile
// half are not modelled.)

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// URI1 — casting a creature from exile (with permission) gains its caster 2 life.
test('URI1 casting a spell from exile gains 2 life', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const uri = await s.spawnCreature('A', 'Urianger Test')
    const exiled = await s.spawn('A', 'Air Elemental Test', 'exile')
    // Grant A permission to play the exiled card.
    await client.query(
      `insert into public.game_continuous_effects (session_id, source_card_id, affected_player_id, effect_type, payload)
       values ($1, $2, $3, 'play_from_exile', $4::jsonb)`,
      [s.sessionId, uri, s.players.A, JSON.stringify({ card_ids: [exiled], permanent: true })],
    )

    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    await s.setMana('A', { U: 1, C: 4 })
    const lifeBefore = await s.lifeOf('A')

    await s.as('A').castPermanent(exiled)   // cast from exile -> fires cast_from_exile
    await s.as('A').resolveStack()           // Urianger's gain-2 trigger resolves

    assert.equal(await s.lifeOf('A'), lifeBefore + 2)
  })
})
