// Commander (EDH) slice 3 — the deck side (mig 138). A deck can designate a
// commander; spawn_deck_for_session seeds the library from list_data and, in a
// Commander game, puts the commander into the command zone.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => {
  await ensureTestCards()
})

const LIST = ['Air Elemental Test', 'Frost Ward Test', 'Searing Spear Test']

// DK1 — a standard game seeds the whole deck into the library, nothing in command.
test('DK1 a standard deck seeds into the library only', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const deck = await s.createDeck('A', LIST, 'Goblin Raider Test') // commander ignored in standard
    const res = await s.as('A').spawnDeck(deck)

    assert.equal(res.library, 3)
    assert.equal(res.commander_seeded, false)
    assert.equal(await s.zoneCount('A', 'library'), 3)
    assert.equal(await s.zoneCount('A', 'command'), 0)
  })
})

// DK2 — a Commander game puts the commander in the command zone (not the library),
// and does NOT double-seed it even when the decklist still lists it.
test('DK2 a commander deck seeds its commander into the command zone', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 2, { format: 'commander' })
    // The list INCLUDES the commander (as an imported decklist would).
    const deck = await s.createDeck('A', [...LIST, 'Goblin Raider Test'], 'Goblin Raider Test')
    const res = await s.as('A').spawnDeck(deck)

    assert.equal(res.library, 3) // the 3 non-commander cards; commander excluded
    assert.equal(res.commander_seeded, true)
    assert.equal(await s.zoneCount('A', 'library'), 3)
    assert.equal(await s.zoneCount('A', 'command'), 1)

    // The command-zone card is the commander and flagged.
    const r = await s.client.query<{ card_id: string; is_commander: boolean }>(
      "select gc.card_id, gc.is_commander from public.game_cards gc where gc.session_id = $1 and gc.zone = 'command'",
      [s.sessionId],
    )
    assert.equal(r.rows[0]?.is_commander, true)
    assert.equal(r.rows[0]?.card_id, await s.cardId('Goblin Raider Test'))
  })
})

// DK3 — set_deck_commander designates the commander on an existing deck.
test('DK3 set_deck_commander designates a commander', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const deck = await s.createDeck('A', LIST) // no commander yet
    assert.equal(await s.deckCommander(deck), null)

    await s.as('A').setDeckCommander(deck, 'Goblin Raider Test')
    assert.equal(await s.deckCommander(deck), await s.cardId('Goblin Raider Test'))
  })
})

// DK4 — a player can only seed one deck per session.
test('DK4 spawning a second deck is rejected', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const deck = await s.createDeck('A', LIST)
    await s.as('A').spawnDeck(deck)

    await assert.rejects(() => s.as('A').spawnDeck(deck), /already have a deck/i)
  })
})
