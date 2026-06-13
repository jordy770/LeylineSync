// mig 289 — omen back-face casts: hand-zone activated abilities with the
// shuffle-self rider (Flush Out / Dynamic Soar).

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// OC1 — Flush Out from hand: discard one, draw two, the card shuffles into
// the library instead of hitting the graveyard.
test('OC1 Flush Out casts from hand and shuffles itself away', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    // Local catalog row for the DFC (tx-scoped, like the smoke test).
    const scripts = JSON.parse(readFileSync('docs/commander-decks/card-scripts.json', 'utf8'))
    await client.query(
      `insert into public.cards (id, name, type_line, oracle_text, power_toughness, mana_cost, is_token, script)
       values (gen_random_uuid(), 'Stormshriek Feral // Flush Out', 'Creature — Dragon // Sorcery — Omen', null, '3/3', '{4}{R}', false, $1::jsonb)`,
      [JSON.stringify(scripts['Stormshriek Feral // Flush Out'])])
    const omen = await s.spawn('A', 'Stormshriek Feral // Flush Out', 'hand')
    const fodder = await s.spawn('A', 'Wastes Test', 'hand') // discard fuel
    for (let i = 0; i < 2; i++) await s.spawn('A', 'Forest Test', 'library')
    await s.setMana('A', { R: 1, C: 1 })

    await s.as('A').activate(omen, 1) // index 1 = the hand-zone Flush Out
    await s.as('A').resolveStack()
    const d = await s.pendingDecision()
    assert.equal(d!.decision_type, 'choose_cards') // the discard park
    await s.as('A').submitDecision(d!.id, { chosen: [fodder] })

    const row = await s.client.query<{ zone: string }>(
      'select zone from public.game_cards where id = $1', [omen])
    assert.equal(row.rows[0]!.zone, 'library') // shuffled away, not graveyarded
    const hand = await s.client.query<{ n: string }>(
      `select count(*)::int as n from public.game_cards
       where session_id = $1 and owner_id = $2 and zone = 'hand'`,
      [s.sessionId, s.players.A])
    assert.equal(Number(hand.rows[0]!.n), 2) // drew two (fodder discarded, omen gone)
  })
})
