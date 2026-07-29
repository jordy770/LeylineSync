# Deck Generation from Collection (Buildable Commanders Phase 2) — Design Spec

**Date:** 2026-07-29
**Problem:** Phase 1 (spec `2026-07-29-buildable-commanders-design.md`, shipped)
tells the user WHICH commanders their collection supports; the started deck is
still empty. Phase 2 generates a complete 99-card proposal from the collection
for a chosen commander — preview first, save on confirmation.

## Decisions (validated with Jordy)

1. **Flow: preview → save.** "Generate decklist" is the primary action in the
   phase-1 detail panel (both ranked-list and lookup entry points; the
   free-only/whole-collection toggle carries over). The user sees the full
   proposal before anything is written; "Start this deck" remains as the
   secondary "Start empty" action.
2. **Gaps: basics + buy suggestions.** Land shortfall is always filled with
   basics (distribution below). Nonland bucket shortfalls do NOT block saving:
   the preview shows a Gaps block with budget-aware buy suggestions via the
   existing `suggestBuys` (top 2 per short bucket, with prices); the deck saves
   with what the user owns.
3. **Algorithm: greedy bucket-fill with synergy ordering** (deterministic, no
   AI, explainable per card). Not plain tag-greedy, not iterative optimization.

## Section 1 — UX

- Detail panel (`BuildableCommanders.tsx`) gains **Generate decklist**
  (primary) next to **Start empty** (the renamed existing button).
- Preview state, rendered in the same panel: proposal grouped per bucket, each
  card with a reason chip (bucket · theme-match · synergy score); a lands line
  ("14 owned lands + 23 basics — W7 U6 B5 G5"); a Gaps block when buckets fall
  short (buy suggestions with prices, links via the existing shop-links
  helpers); **Save deck (N)** at the bottom → creates the deck and navigates to
  `/collection/decks/[id]`.
- Lookup mode (unowned commander) generates and saves the same way — owning
  the commander is a paper problem (phase-1 ruling). The unowned notice stays
  visible in the preview.
- Regenerate on toggle flip: flipping free-only/whole-collection while a
  preview is open refetches the proposal for the new mode.

## Section 2 — Generator (pure module)

New `lib/collection/deck-generator.ts`, pure and deterministic, beside
`commander-suggest.ts`. Reuses the phase-1 card facts (tags, subtypes,
keywords, identity) and `commanderSynergy` from the existing `scoring.ts`.
The phase-1 loader gains the `cmc` field (already present on `co_card_oracle`).

- **Target: 99 = 62 nonland + 37 land** (matches `power-score.ts` targets).
- **Candidate pool:** the phase-1 pool rules verbatim (identity subset via
  `fitsColorIdentity`, basics excluded from the nonland pool, free-only vs
  whole-collection per the toggle, commander excluded).
- **Nonland fill:** buckets in fixed order ramp(10) → card_draw(10) →
  removal(8) → board_wipe(3) → creatures(25), then filler up to 62. Within a
  bucket, candidates sort by `tagWeight + themeMatch + commanderSynergy`
  (themeMatch: +2 tribal subtype hit, +1 keyword overlap), tie-break name asc.
  A chosen card leaves the pool (singleton per oracle_id, one bucket per
  card). Filler sorts by the same synergy score with a curve brake (cmc > 6 →
  −1).
- **Lands (37):** owned in-identity lands first (nonbasic; any-color sources
  ranked first, then name), remainder basics. Basic split follows the color
  distribution of the chosen 62 nonlands' color_identity counts (no mana_cost
  column exists on `co_card_oracle`; identity counts are the available
  approximation), with a minimum of 1 basic per identity color; colorless
  identity → Wastes.
- **Output:** `DeckProposal = { cards: { oracleId, name, bucket, reasons }[],
  ownedLands: [...], basics: Record<Color, number>, gaps: { bucket, shortfall,
  buys }[], totals: { nonland, ownedLand, basicLand } }`.
- Deterministic: same inputs → identical proposal.

## Section 3 — API & saving

- `POST /api/collection/commanders/generate` `{ oracleId, freeOnly }` →
  `{ proposal }`. Server-side: phase-1 loader + generator + `suggestBuys` for
  gaps. Same auth pattern as the existing commanders routes.
- `POST /api/collection/commanders/save-deck` `{ oracleId, name, cards:
  { oracleId, quantity }[] }` → `{ deckId }`. Server-side REVALIDATION before
  insert — never trust the client list: every nonbasic card owned (per the
  availability view), inside the commander's identity, singleton (quantity > 1
  is rejected for nonbasics; only basic lands may carry quantity > 1); basics
  are exempt from the owned check. Inserts `co_decks` **including `color_identity`
  (deduped+sorted, the phase-1 lesson)** + commander row (`is_commander:
  true`) + all card rows, chunked like `import-deck.ts`; deletes the deck row
  if any insert fails.
- "Start empty" keeps using the existing start-deck route unchanged.

## Verification / success criteria

1. Unit tests (node:test) for the generator: determinism, singleton, 62/37
   split, bucket fill order + within-bucket ordering, curve brake, basics
   distribution incl. minimum-per-color and colorless→Wastes, identity guard,
   gaps computation, lookup-mode parity.
2. Save-deck revalidation tests where feasible at unit level (pure validation
   helper), plus e2e on the real local collection: preview < 1.5s; saved deck
   opens on the deck page with 100 cards and a computable power score.
   Local-DB safety rules apply (feature-driven writes only, report created
   deck ids).
3. No LLM calls; no new tables or migrations.

## Out of scope

- Editing within the preview (pruning happens on the existing deck page).
- AI ranking/explanations; EDHRec data.
- Multi-deck optimization across commanders; upgrade suggestions for the
  generated deck (the existing Advisor covers that once the deck exists).
