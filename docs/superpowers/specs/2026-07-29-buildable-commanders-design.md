# Buildable Commanders (Collection → Commander Suggestions) — Design Spec

**Date:** 2026-07-29
**Problem:** The collection module can improve EXISTING decks (Advisor / upgrade
scanner) but never answers the inverse question: *which commander decks could I
build from what I own?* That discovery moment ("I apparently own 30 Elves") is
the missing half of the "personal EDHRec" vision
(`docs/collection-optimizer/ARCHITECTURE.md`, §12 v2).

**Phasing (validated with Jordy):** two phases, each with its own spec/plan.
- **Phase 1 (this spec):** ranked commander suggestions from the collection.
- **Phase 2 (separate spec, later):** generating a full 100-card deck proposal
  for a chosen commander. Out of scope here.

## Decisions (validated with Jordy)

1. **Placement:** a new section on the existing **Advisor** page
   (`app/collection/advisor`) — the Advisor becomes the single "what can I do
   with my collection" surface. No new navigation item (the fragmented
   collection IA is a known usability gap; don't add to it).
2. **Ownership semantics:** toggle with default **free cards only** (cards not
   locked in any deck, via `co_card_availability`) — "what can you build NOW
   without cannibalizing". The other position scores against the whole
   collection and shows per suggestion how many cards would have to come out of
   existing decks.
3. **Ranking:** deterministic heuristic — bucket-weighted **completeness** plus
   a capped **theme boost**. No LLM anywhere in this feature (free path stays
   heuristic per the standing AI-paywall rule).

## Section 1 — UX

- Advisor page, below the existing upgrade sections: **"Commanders you can
  build"** — top 10 (with "show more"), each row: commander art thumb, name,
  color identity pips, and a transparent explanation line, e.g.
  *"62 free playable cards · strong in ramp/draw · 24 Elves"*.
- Section-level toggle: **Only free cards (default) / Whole collection**. In
  whole-collection mode each row additionally shows "N cards sit in existing
  decks".
- Row click opens a detail panel: owned support per bucket (ramp / draw /
  removal / wipes / creatures / other) against the ideal profile, biggest gaps
  named, and a **"Start this deck"** button that creates an empty `co_` deck
  with this commander designated (existing deck-mutations path) and navigates
  to it. Filling the list is Phase 2.
- Empty states: no collection imported → pointer to import; collection without
  owned legendaries → explanatory empty state.

## Section 2 — Scoring (pure, deterministic)

New module `lib/collection/commander-suggest.ts` (pure functions, unit-tested)
next to `upgrade-scanner.ts`.

- **Candidates:** owned cards that are legendary creatures OR carry "can be
  your commander" in oracle text. In free-only mode the commander itself must
  also be free (a suggestion must never require breaking a deck for its own
  commander); in whole-collection mode a locked commander is allowed and
  labeled as locked.
- **Pool per candidate:** owned cards (per the toggle: free-only or all) whose
  color identity is a subset of the commander's. **Basic lands count as always
  available and never limit a suggestion** (completeness is computed over the
  ~63 nonbasic slots of a typical list).
- **Completeness score:** bucket coverage vs an ideal profile (reusing the
  tagger buckets from `co_card_tags` and the ideal-profile philosophy of
  `power-score.ts`): Σ per bucket min(owned, ideal) weighted by bucket weight,
  normalized 0–100.
- **Theme boost (capped so completeness stays dominant):**
  - Tribal: creature types named in the commander's oracle text → count owned
    matching creatures in identity; boost scales with count.
  - Keyword overlap: commander's recurring keywords (from the catalog
    `keywords`) present on owned pool cards.
- **Output per suggestion:** score, ownedPlayable count, per-bucket coverage,
  theme facts (for the explanation line), locked-count (whole-collection mode).
- Ordering is fully deterministic (score desc, then name) — same input, same
  list.

## Section 3 — Data & performance

- **No new tables, no migrations.** Reads: `co_collection_items`,
  `co_card_availability` (free vs locked), `co_card_oracle` / `cards` mirror
  (type_line, oracle_text, color_identity, keywords), `co_card_tags` (buckets).
- Server-side computation during the Advisor load (server component / helper
  call beside the upgrade scan), SQL prefilter (color-identity containment,
  owned join) → scoring in TS. Target: <1s on a realistic collection
  (architecture §10 pattern). No caching in phase 1; add only if measured slow.
- "Start this deck" reuses existing deck-creation mutations — no new write
  paths beyond that call.

## Verification / success criteria

1. Unit tests (node:test) for the scoring module: color-identity subset rule,
   basics-never-limit rule, bucket completeness math, tribal boost, boost cap,
   free-vs-all toggle semantics, deterministic ordering.
2. Manual check against Jordy's real local collection: suggestions render <1s,
   the explanation lines read sensibly, and a known tribal cluster in the
   collection surfaces near the top.
3. No LLM calls introduced anywhere in this feature.

## Out of scope

- Phase 2: full deck generation / filling the started deck.
- Any AI/LLM ranking or explanations.
- New navigation items or pages; schema changes; EDHRec data (legal risk — own
  heuristics only, per architecture §9).
