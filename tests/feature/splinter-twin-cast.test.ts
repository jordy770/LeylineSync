// Splinter Twin — Aura-cast-attach verification. Confirms the FULL path (not the
// manual-attach shortcut from splinter-twin.test.ts): casting the Aura from hand
// targeting a creature attaches it (handle_cast_permanent) and the granted_ability
// (mig 357) then gives the host its "{T}: copy this creature" activated ability.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

// ST-CAST — cast Splinter Twin on a creature; it attaches and grants the copy ability.
test('Splinter Twin attaches when cast and grants the copy ability', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const host = await s.spawnCreature('A', 'Vampire Bear Test')
    const twin = await s.spawn('A', 'Splinter Twin Test', 'hand') // {U} Aura
    await s.setMana('A', { U: 1 })

    await s.as('A').castPermanent(twin, { target: host }) // cast targeting the creature
    await s.as('A').resolveStack()

    // The Aura attached to the host (handle_cast_permanent), not a manual set.
    const attached = await s.client.query<{ attached_to: string | null }>(
      'select attached_to from public.game_cards where id = $1', [twin])
    assert.equal(attached.rows[0]?.attached_to, host, 'Aura attached to its target on cast')
    assert.equal(await s.zoneOf(twin), 'battlefield')

    // The granted "{T}: create a token copy of this creature, haste" now resolves.
    await s.as('A').activate(host, 0)
    while (await s.topStackItem()) await s.as('A').resolveStack()
    const toks = await s.client.query<{ id: string }>(
      `select gc.id from public.game_cards gc join public.cards c on c.id = gc.card_id
       where gc.session_id = $1 and gc.zone = 'battlefield' and gc.is_token = true and c.name = 'Vampire Bear Test'`,
      [s.sessionId])
    assert.equal(toks.rows.length, 1, 'the host copied itself via the granted ability')
    assert.equal((await s.cardState(host)).is_tapped, true, 'the host tapped for it')
  })
})
