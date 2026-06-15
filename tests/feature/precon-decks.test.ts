// Shared precon decks (mig 308): a curated deck with is_precon = true and no
// owner is selectable + spawnable by ANY player, not just one who owns it.
// spawn_deck_for_session / commander_deck_legality relax their deck lookup from
// owner-only to "owner_id = me OR is_precon".

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

const LIST = ['Air Elemental Test', 'Frost Ward Test', 'Searing Spear Test']

// PRE1 — a player spawns a shared precon they don't own; the commander lands in
// the command zone, the rest in the library (commander not double-seeded).
test('PRE1 a player can spawn a shared precon deck they do not own', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 2, { format: 'commander' })
    const precon = await s.createPreconDeck('Precon Goblins', [...LIST, 'Goblin Raider Test'], 'Goblin Raider Test')

    const res = await s.as('A').spawnDeck(precon)

    assert.equal(res.commander_seeded, true)
    assert.equal(res.library, 3) // the 3 non-commander cards
    assert.equal(await s.zoneCount('A', 'command'), 1)
    assert.equal(await s.zoneCount('A', 'library'), 3)
  })
})

// PRE2 — the SAME ownerless precon is spawnable by a different player too (the
// whole point: it's shared, not bound to one account).
test('PRE2 a second player can spawn the same shared precon', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 2, { format: 'commander' })
    const precon = await s.createPreconDeck('Precon Goblins', [...LIST, 'Goblin Raider Test'], 'Goblin Raider Test')

    await s.as('A').spawnDeck(precon)
    const res = await s.as('B').spawnDeck(precon)

    assert.equal(res.commander_seeded, true)
    assert.equal(await s.zoneCount('B', 'command'), 1)
    assert.equal(await s.zoneCount('B', 'library'), 3)
  })
})

// PRE3 — a non-owner can run the legality verdict on a precon (lookup relaxed).
test('PRE3 commander_deck_legality reads a shared precon', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const precon = await s.createPreconDeck('Precon Goblins', [...LIST, 'Goblin Raider Test'], 'Goblin Raider Test')

    const v = await s.as('A').commanderDeckLegality(precon)
    assert.equal(v.card_count, 4)
    assert.ok(v.issues.some((i) => /exactly 100/.test(i))) // small fixture deck, but it READS (no "not found")
  })
})
