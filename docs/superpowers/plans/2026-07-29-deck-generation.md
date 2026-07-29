# Deck Generation from Collection (Phase 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the phase-1 detail panel, "Generate decklist" shows a full deterministic 99-card proposal (62 nonland + 37 land) built from the user's collection, with reason chips and gap buy-suggestions; "Save deck" persists it after server-side revalidation.

**Architecture:** A pure generator module (`lib/collection/deck-generator.ts`) consumes the phase-1 card facts + `commanderSynergy` from `scoring.ts`; a gap-buys helper and two new routes (`generate`, `save-deck`) live beside the phase-1 loader/routes; the preview renders inside `BuildableCommanders.tsx`. Spec: `docs/superpowers/specs/2026-07-29-deck-generation-design.md` (including the suggestBuys→gap-buys amendment).

**Tech Stack:** Next.js App Router Route Handlers, Supabase (`co_` views), TypeScript, Node test runner.

## Global Constraints

- **No LLM. No new tables/migrations. Deterministic** (same inputs → identical proposal; no Math.random/Date in logic).
- Phase-1 behavior stays intact: the existing 11 `unit/commander-suggest` tests keep passing unchanged.
- Module boundary: `lib/collection/*`, `components/collection/*`, `app/api/collection/*`, docs, tests, `.wolf` only.
- Targets verbatim from the spec: **99 = 62 nonland + 37 land**; bucket order ramp(10) → card_draw(10) → removal(8) → board_wipe(3) → creatures(25) → filler to 62; within-bucket sort `tagWeight + themeMatch + commanderSynergy` (themeMatch: +2 tribal subtype hit, +1 keyword overlap), filler curve brake cmc>6 → −1, tie-break name asc; singleton per oracle_id, one bucket per card.
- Lands: owned in-identity nonbasic lands first (any-colour producers first — `/add (one|\w+) mana of any color/i` on oracle_text — then name asc), remainder basics split by the colour distribution of the chosen 62 nonlands' color_identity counts, largest-remainder rounding, minimum 1 basic per identity colour, colourless identity → Wastes.
- Save revalidation server-side: every nonbasic owned (`owned_qty > 0` — free-only is generation-time advisory, saving requires owned), inside commander identity (`fitsColorIdentity`), singleton (quantity>1 rejected for nonbasics); basics validated by name whitelist (Plains/Island/Swamp/Mountain/Forest/Wastes), exempt from owned check; `co_decks` insert INCLUDES `color_identity` deduped+sorted (phase-1 lesson); cleanup deck row on any card-insert failure (import-deck.ts pattern); chunked inserts (INSERT_CHUNK pattern from import-deck.ts).
- Auth on both routes mirrors `app/api/collection/search/route.ts` (getClaims → 401).
- Existing signatures consumed: `commanderSynergy(candidateTags: {tag,weight}[], commanderTags: {tag,weight}[]): number` (ratio 0..1, `lib/collection/scoring.ts:63`); `fitsColorIdentity` from upgrade-scanner; phase-1 exports from `commander-suggest.ts` / `commander-suggest-data.ts`.
- Tests: node:test style of `tests/unit/commander-suggest.test.ts` (factories, relative imports). Commits: conventional prefix + trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. OpenWolf bookkeeping per repo rules.

---

### Task 1: Pure generator `deck-generator.ts`

**Files:**
- Modify: `lib/collection/commander-suggest.ts` (export the existing internal `buildCardFacts` + its `CardFacts` type; add OPTIONAL `cmc?: number` to `OwnedOracleCard` — optional so phase-1 factories/tests stay untouched)
- Create: `lib/collection/deck-generator.ts`
- Test: `tests/unit/deck-generator.test.ts`

**Interfaces:**
- Consumes: `OwnedOracleCard`, `CommanderCandidate`, `SuggestOptions`, `buildCardFacts`, `CardFacts`, `pluralizeSubtype` from `./commander-suggest`; `commanderSynergy` from `./scoring`; `fitsColorIdentity` from `./upgrade-scanner`.
- Produces:

```ts
export type BasicName = 'Plains' | 'Island' | 'Swamp' | 'Mountain' | 'Forest' | 'Wastes'
export type ProposalBucket = 'ramp' | 'card_draw' | 'removal' | 'board_wipe' | 'creatures' | 'filler'
export type ProposalCard = { oracleId: string; name: string; bucket: ProposalBucket; reasons: string[] }
export type DeckProposal = {
  cards: ProposalCard[]                       // exactly the chosen nonlands, bucket order
  ownedLands: { oracleId: string; name: string }[]
  basics: Partial<Record<BasicName, number>>
  gapBuckets: { bucket: ProposalBucket; shortfall: number }[]
  totals: { nonland: number; ownedLand: number; basicLand: number }  // nonland + ownedLand + basicLand ≤ 99
}
export function generateDeckProposal(
  commander: CommanderCandidate,
  collection: OwnedOracleCard[],
  opts: SuggestOptions,
): DeckProposal
```

Reasons per card: bucket label always; `'tribal: <Type>'` when the card's subtypes include the commander's tribal type; `'keyword: <K>'` on keyword overlap; `'synergy <n>'` where n = `Math.round(commanderSynergy(...)*10)` when > 0. Gap shortfalls only for the five profile buckets (never filler). When even filler cannot reach 62, `totals.nonland < 62` and basics still cap the deck at ≤99 (never exceed 37 lands).

- [ ] **Step 1: Write the failing tests** — create `tests/unit/deck-generator.test.ts` with the phase-1 factory pattern (copy the `card()`/`cmdr()` factories from `tests/unit/commander-suggest.test.ts`, add `cmc` where needed) covering, each as its own `test()` with concrete fixtures and exact assertions:
  1. determinism: two calls, `assert.deepEqual` of the full proposals;
  2. singleton + one-bucket-per-card: a card tagged both ramp and card_draw appears once, in ramp (first bucket in order);
  3. bucket capacities: 12 ramp-tagged cards → exactly 10 in ramp, the other 2 eligible for filler;
  4. within-bucket ordering: higher tag weight wins; tie broken by name asc;
  5. tribal/keyword reasons present on matching cards, `synergy n` only when > 0;
  6. curve brake: two otherwise-equal filler candidates, cmc 7 vs cmc 3 → cmc 3 chosen first;
  7. 62/37 split: big enough pool → totals `{ nonland: 62, ownedLand: k, basicLand: 37-k }`;
  8. owned lands ranked any-colour first (oracle_text 'Add one mana of any color.') then name;
  9. basics distribution: identity ['W','U'], chosen nonlands 3× W-identity + 1× U-identity, 0 owned lands → 37 basics split by largest remainder with ≥1 per colour (assert exact counts: Plains 28, Island 9 — the 3:1 largest-remainder split of 37);
  10. colourless commander → all basics Wastes;
  11. gapBuckets: pool with only 4 ramp and nothing else → ramp shortfall 6 (and other buckets' shortfalls present), filler never in gapBuckets;
  12. freeOnly semantics: locked cards excluded in freeOnly, included otherwise (reuse phase-1 pool rules — commander excluded, basics excluded from nonland pool).
- [ ] **Step 2: Run to verify RED** — `npm test -- unit/deck-generator` → module not found.
- [ ] **Step 3: Implement** — in `commander-suggest.ts` add `export` to `buildCardFacts`/`CardFacts` and `cmc?: number` on `OwnedOracleCard`; write `deck-generator.ts`: build facts once, pool per phase-1 rules, fixed bucket loop consuming candidates from a name-sorted, score-sorted array, land selection, largest-remainder basics, gap computation. Pure; no I/O.
- [ ] **Step 4: Verify GREEN** — `npm test -- unit/deck-generator` all pass AND `npm test -- unit/commander-suggest` still 11/11.
- [ ] **Step 5: Commit** — `feat(collection): deck-generator — deterministic 62/37 proposal from collection` + trailer.

---

### Task 2: Loader cmc + gap buys + generate route

**Files:**
- Modify: `lib/collection/commander-suggest-data.ts` (add `cmc` to both oracle selects/mappings; add `findGapBuys`)
- Create: `app/api/collection/commanders/generate/route.ts`

**Interfaces:**
- Consumes: Task 1's `generateDeckProposal`, `DeckProposal`, `ProposalBucket`; phase-1 `loadOwnedOracleCards`, `loadCommanderCandidate`.
- Produces:
  - `loadOwnedOracleCards` / `loadCommanderCandidate` rows now carry `cmc` (from `co_card_oracle.cmc`, `?? 0`).
  - `findGapBuys(supabase, userId, commanderIdentity: string[], gapBuckets: { bucket: ProposalBucket; shortfall: number }[]): Promise<{ bucket: ProposalBucket; buys: { oracleId: string; name: string; priceEur: number | null }[] }[]>` — per gap bucket (skip 'creatures': too generic to shop for; note this in a comment): query `co_card_tags` for that tag joined to `co_card_oracle`, exclude oracle_ids the user owns (chunked availability lookup reuse), filter `fitsColorIdentity` in TS, sort by `(prices->>'eur')::numeric` asc nulls last then name, take 2.
  - Route `POST /api/collection/commanders/generate` body `{ oracleId: string, freeOnly: boolean }` → `{ proposal: DeckProposal & { gaps: { bucket; shortfall; buys }[] } }`; 401/400/404 shapes as the phase-1 route.
- [ ] **Step 1: Implement loader cmc + findGapBuys** (mapping/query only — no scoring).
- [ ] **Step 2: Implement the route** (auth → loadCommanderCandidate (404 on null) → loadOwnedOracleCards → generateDeckProposal → findGapBuys → merge gaps → json).
- [ ] **Step 3: Verify** — `npx tsc --noEmit`; `npx eslint lib/collection/commander-suggest-data.ts app/api/collection/commanders/generate/route.ts`; `npm test -- unit/deck-generator unit/commander-suggest` green.
- [ ] **Step 4: Commit** — `feat(collection): generate route + gap buys for deck proposals` + trailer.

---

### Task 3: Save-deck route with pure revalidation

**Files:**
- Create: `lib/collection/proposal-validate.ts`
- Create: `app/api/collection/commanders/save-deck/route.ts`
- Test: `tests/unit/proposal-validate.test.ts`

**Interfaces:**
- Consumes: `fitsColorIdentity`; types from Task 1.
- Produces:

```ts
export type SavePayloadCard = { oracleId: string; quantity: number }
export type SavePayloadBasics = { name: BasicName; quantity: number }[]
export type CardMeta = { oracleId: string; colorIdentity: string[]; typeLine: string; ownedQty: number }
export function validateProposal(
  cards: SavePayloadCard[],
  basics: SavePayloadBasics,
  commanderIdentity: string[],
  metaByOracle: Map<string, CardMeta>,
): { ok: true } | { ok: false; error: string }
```

Rules (each its own test, RED first): duplicate oracleId → error; quantity ≠ 1 on a nonbasic → error; card missing from meta (unknown) → error; `ownedQty < 1` → error; identity violation → error; basics name outside the whitelist → error; basics quantity < 1 → error; total cards+basics+commander > 100 → error; happy path → ok.

Route `POST /api/collection/commanders/save-deck` body `{ oracleId, name, cards, basics }` → `{ deckId }`:
auth (mirror phase-1) → commander row from `co_card_oracle` (404) → meta for submitted oracleIds (oracle rows + availability, chunked) → `validateProposal` (400 with its error on failure) → insert `co_decks { user_id, name, commander_oracle_id, color_identity: [...new Set(commander.color_identity)].sort() }` → rows: commander `{ quantity: 1, is_commander: true }`, each nonbasic `{ quantity: 1 }`, each basic (resolve oracle_id by name from `co_card_oracle` where `type_line ilike 'Basic Land%'` and exact name, `maybeSingle`) with its quantity — inserted in chunks of 500 (`INSERT_CHUNK` in `import-deck.ts:74`); on ANY card-insert failure delete the deck row and 500.

- [ ] **Step 1: Write failing validator tests** (`npm test -- unit/proposal-validate` → RED).
- [ ] **Step 2: Implement `proposal-validate.ts`** (pure) → GREEN.
- [ ] **Step 3: Implement the route.**
- [ ] **Step 4: Verify** — tsc, eslint on the three files, `npm test -- unit/proposal-validate unit/deck-generator unit/commander-suggest` green.
- [ ] **Step 5: Commit** — `feat(collection): save-deck route with server-side proposal revalidation` + trailer.

---

### Task 4: Preview UI in BuildableCommanders

**Files:**
- Modify: `components/collection/BuildableCommanders.tsx`

**Interfaces:**
- Consumes: `POST /api/collection/commanders/generate` and `.../save-deck` (Tasks 2–3 shapes verbatim).

Behavior (spec §1): in `SuggestionDetail`, rename the existing button to **Start empty** (keeps calling start-deck) and add primary **Generate decklist** → POST generate → preview state replaces the bucket-bars block: groups per bucket (cards with reason chips), lands line `"{ownedLand} owned lands + {basicLand} basics — {per-colour counts}"`, Gaps block (per bucket: shortfall + up to 2 buys with `€price`), buttons **Save deck (N)** (N = nonland+ownedLand+basicLand+1) and **Back**. Save → POST save-deck (cards = proposal nonlands+ownedLands as quantity 1; basics from the proposal record) → `router.push('/collection/decks/'+deckId)`. Toggle flip while a preview is open refetches generate with the new `freeOnly`. Loading and error states for both calls (reuse the panel's existing fetch-state pattern). Unowned-commander notice stays visible above the preview.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Verify** — `npx tsc --noEmit`; `npx eslint components/collection/BuildableCommanders.tsx`; `npx next build` (client/server import gotcha — cerebrum); unit suites unchanged.
- [ ] **Step 3: Commit** — `feat(collection): deck proposal preview + save in Buildable Commanders panel` + trailer.

---

### Task 5: End-to-end verification + OpenWolf

**Files:**
- Modify: `.wolf/anatomy.md`, `.wolf/memory.md`

- [ ] **Step 1: Gates** — `npm test` (full suite green), `npx eslint .` (only the 2 known doc/*.js errors), `npx tsc --noEmit`.
- [ ] **Step 2: Real-collection e2e** (local DB read-only; ONLY feature-driven writes; report created deck name+id): via the magic-link + real-HTTP method documented in the phase-1 Task 4 report — POST generate for an owned commander (time it: < 1.5s), assert proposal shape (62/37 or documented shortfall), POST save-deck, then GET the deck page data path (or open headless) and confirm: 100 rows, commander flagged, `co_decks.color_identity` = commander's sorted identity, power score computes. Also: generate for an UNOWNED lookup commander succeeds; save-deck with a tampered payload (a not-owned oracleId injected) returns 400.
- [ ] **Step 3: OpenWolf** — anatomy entries for the new files; memory line with actual time.
- [ ] **Step 4: Commit** — `chore(wolf): log deck generation phase 2` + trailer.
