// mig 251 — Reality Shift (manifest): "Exile target creature. Its controller
// manifests the top card of their library."
//   • The manifested card enters as a blank 2/2 (copied_script {} + an
//     unexpiring set_pt; register skips manifested cards so printed keywords
//     stay off across rebuilds).
//   • turn_manifest_up flips a creature card face up for its mana cost (no
//     ETB — turning up is not a zone change). The card's identity is not
//     visually hidden from the table (client approximation).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { asPlayer, rpc, withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// RS1 — exile the target; its controller's top card hits the battlefield as
// a blank 2/2 even though it's printed as a 5/5 flyer.
test('RS1 Reality Shift exiles and manifests a blank 2/2', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const victim = await s.spawnCreature('B', 'Rapacious Dragon Test')
    await s.as('B').resolveStack() // its ETB Treasures
    const top = await s.spawn('B', 'Sarkhan, Soul Aflame Test', 'library') // printed 5/5

    await s.as('A').castSpellEffect(
      [{ type: 'exile_and_manifest', target_type: 'creature' }], null, null, victim)
    await s.as('A').resolveStack()

    const gone = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [victim])
    assert.equal(gone.rows[0]!.zone, 'exile')

    const m = await s.client.query<{ zone: string; controller: string; manifested: string | null }>(
      `select zone, coalesce(controller_player_id, owner_id) as controller,
              counters ->> 'manifested' as manifested
       from public.game_cards where id = $1`, [top])
    assert.equal(m.rows[0]!.zone, 'battlefield')
    assert.equal(m.rows[0]!.controller, s.players.B)
    assert.ok(m.rows[0]!.manifested)
    assert.equal(await s.effectivePower(top), 2) // blank 2/2, not 5/5
    await s.as('B').rebuild() // printed keywords must stay off while face down
    assert.equal(await s.effectivePower(top), 2)
  })
})

// RS2 — turning face up restores the real card.
test('RS2 a manifested creature turns face up for its mana cost', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const victim = await s.spawnCreature('B', 'Dragon Token')
    const top = await s.spawn('B', 'Sarkhan, Soul Aflame Test', 'library') // {3}{R}, 5/5

    await s.as('A').castSpellEffect(
      [{ type: 'exile_and_manifest', target_type: 'creature' }], null, null, victim)
    await s.as('A').resolveStack()
    assert.equal(await s.effectivePower(top), 2)

    await s.setMana('B', { R: 1, C: 3 })
    await asPlayer(s.client, s.players.B, () =>
      rpc(s.client, 'turn_manifest_up', {
        p_session_id: s.sessionId,
        p_game_card_id: top,
        p_generic_payment: null,
      }))

    assert.equal(await s.effectivePower(top), 5) // the printed card again
    const m = await s.client.query<{ manifested: string | null; cs: string | null }>(
      `select counters ->> 'manifested' as manifested, copied_script::text as cs
       from public.game_cards where id = $1`, [top])
    assert.equal(m.rows[0]!.manifested, null)
    assert.equal(m.rows[0]!.cs, null)
  })
})
