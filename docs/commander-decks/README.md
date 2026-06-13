# Sample Commander decklists

Real preconstructed-style Commander (EDH) decks in the format the in-app importer
(`import_deck_from_text`) accepts: one `1 Card Name` line per card, `#` comments and
section headers (`Commander`, `Deck`) ignored.

## How to use

1. Make sure your card catalog has these cards (the importer matches by **name** and
   lists any it can't find as "not accepted lines" — fix those and re-import).
2. In the app: **Decks → Import a deck**, paste the file's contents, give it a name.
   The card under the `Commander` header is captured as the deck's commander
   automatically (you can still change it with the **★** toggle on any card row).
3. The commander is excluded from the library and seeded into the command zone when
   you start a **Commander** game.
4. In the lobby, create a game with the **Commander** format, then spawn this deck.

## Implementing a new deck's card behaviors

1. Paste the decklist into `next-deck.txt` (keep the `Commander` header).
2. `npm run deck:triage` — writes `next-deck.triage.md`: which cards already have
   engine tests, which work without authoring, and which need building (with
   their ground-truth oracle text, ready to plan from).
3. Work through the "Needs building" section; when the deck is done, copy
   `next-deck.txt` to `<deck-name>.txt` and paste the next list.

## Decks

- `krenko-goblins.txt` — Krenko, Mob Boss (mono-red goblin aggro)
- `atraxa-counters.txt` — Atraxa, Praetors' Voice (WUBG +1/+1 counters / superfriends)

> These are starting points, not tournament lists. Card names use canonical Scryfall
> spellings; if your catalog is a subset, expect some lines to be flagged on import.
