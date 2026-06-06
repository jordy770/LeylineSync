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

// DK5 — the text importer captures the card under a "Commander" header as the
// deck's commander (still counted in the 100).
test('DK5 importing a decklist captures the Commander section', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const result = await s.as('A').importDeck(
      'Imported EDH',
      ['Commander', '1 Goblin Raider Test', 'Deck', '1 Air Elemental Test', '1 Frost Ward Test'].join('\n'),
    )

    assert.equal(result.card_count, 3) // commander counts toward the deck
    assert.equal(result.commander_card_id, await s.cardId('Goblin Raider Test'))
    assert.equal(await s.deckCommander(result.id!), await s.cardId('Goblin Raider Test'))
  })
})

// DK6 — a decklist with no Commander section imports with no commander (use ★).
test('DK6 a decklist without a Commander section has no commander', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const result = await s.as('A').importDeck(
      'Plain deck',
      ['1 Air Elemental Test', '1 Frost Ward Test'].join('\n'),
    )

    assert.equal(result.card_count, 2)
    assert.equal(result.commander_card_id, null)
  })
})

// DK7 — end-to-end: import a commander decklist, then spawn it into a Commander
// game — the captured commander lands in the command zone, not the library.
test('DK7 imported commander deck seeds the command zone', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 2, { format: 'commander' })
    const result = await s.as('A').importDeck(
      'EDH',
      ['Commander', '1 Goblin Raider Test', 'Deck', '1 Air Elemental Test', '1 Frost Ward Test'].join('\n'),
    )
    await s.as('A').spawnDeck(result.id!)

    assert.equal(await s.zoneCount('A', 'command'), 1) // the commander
    assert.equal(await s.zoneCount('A', 'library'), 2) // the other two, not the commander
  })
})

// A legal Commander deck: 100 cards (commander + 99 basics — basics are singleton-
// exempt and colourless, so always within the commander's identity).
const legalCommanderDeck = ['Goblin Raider Test', ...Array(99).fill('Wastes Test')]

// LEG1 — the server verdict flags an undersized deck as illegal.
test('LEG1 commander_deck_legality rejects an undersized deck', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const deck = await s.createDeck('A', LIST, 'Goblin Raider Test') // 3 cards
    const v = await s.as('A').commanderDeckLegality(deck)

    assert.equal(v.legal, false)
    assert.equal(v.card_count, 3)
    assert.ok(v.issues.some((i) => /exactly 100/.test(i)))
  })
})

// LEG2 — a legal 100-card deck passes the verdict.
test('LEG2 commander_deck_legality accepts a legal 100-card deck', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    const deck = await s.createDeck('A', legalCommanderDeck, 'Goblin Raider Test')
    const v = await s.as('A').commanderDeckLegality(deck)

    assert.equal(v.card_count, 100)
    assert.deepEqual(v.issues, [])
    assert.equal(v.legal, true)
  })
})

// LEG3 — colour identity: a blue card under a mono-red commander is off-identity.
test('LEG3 commander_deck_legality flags off-colour-identity cards', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    // Mind Spring Test is {X}{U} (blue); the commander is mono-red.
    const deck = await s.createDeck('A', ['Goblin Raider Test', 'Mind Spring Test'], 'Goblin Raider Test')
    const v = await s.as('A').commanderDeckLegality(deck)

    assert.equal(v.legal, false)
    assert.ok(v.issues.some((i) => /colour identity/.test(i)))
  })
})

// LEG4 — enforcement: a Commander game seeds a legal deck under enforcement.
test('LEG4 spawn accepts a legal deck under enforcement', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 2, { format: 'commander' })
    const legal = await s.createDeck('A', legalCommanderDeck, 'Goblin Raider Test')
    const res = await s.as('A').spawnDeck(legal, { enforceLegality: true })

    assert.equal(res.commander_seeded, true)
    assert.equal(res.library, 99) // 99 basics; commander to the command zone
  })
})

// LEG5 — enforcement: a Commander game refuses to seed an illegal deck. (Kept as the
// last action — an expected RPC rejection aborts the test transaction.)
test('LEG5 spawn refuses an illegal deck under enforcement', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client, 2, { format: 'commander' })
    const illegal = await s.createDeck('A', LIST, 'Goblin Raider Test') // 3 cards
    await assert.rejects(
      () => s.as('A').spawnDeck(illegal, { enforceLegality: true }),
      /not Commander-legal/i,
    )
  })
})
