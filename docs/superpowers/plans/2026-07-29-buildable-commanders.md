# Buildable Commanders (Phase 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Advisor page ranks commanders the user can build from their collection (free-cards default, whole-collection toggle) and lets them check ANY commander from the catalog against their collection — deterministic heuristics, no AI.

**Architecture:** A pure scoring module (`lib/collection/commander-suggest.ts`) computes completeness + theme boost from owned-card shapes; a thin server loader assembles those shapes from the existing `co_` views; the Advisor server component computes both toggle variants and renders a client section; one API route serves the lookup search + scoring of an arbitrary commander; "Start this deck" reuses the `co_decks` insert pattern from `import-deck.ts`. Spec: `docs/superpowers/specs/2026-07-29-buildable-commanders-design.md`.

**Tech Stack:** Next.js App Router (server components + Route Handlers), Supabase (`co_` views, RLS), TypeScript, Node test runner (`npm test -- unit/commander-suggest`).

## Global Constraints

- **No LLM calls anywhere in this feature** (free path stays heuristic — standing rule).
- **No new tables, no migrations.** Reads only: `co_collection_items` (via views), `co_card_availability` (user_id, oracle_id, owned_qty, free_qty, committed_qty), `co_card_oracle` (oracle_id, name, color_identity, cmc, type_line, oracle_text, keywords, prices), `co_card_tags` (oracle_id, tag, weight, source). One new write path: "Start this deck" inserting `co_decks` + one `co_deck_cards` row (mirrors `lib/collection/import-deck.ts:56-77`).
- **Module boundary:** everything under `lib/collection/*`, `components/collection/*`, `app/collection/*`, `app/api/collection/*`. Never touch `game_cards`, RPC functions, or the `cards` game mirror write-side.
- **Determinism:** same input → same ordering (score desc, then name asc). No `Math.random`, no Date-dependent scoring.
- **No EDHRec data** (legal risk per architecture §9) — own heuristics only.
- Reuse `fitsColorIdentity(cardIdentity, deckIdentity)` exported by `lib/collection/upgrade-scanner.ts:261` — do not re-implement.
- Tests: Node test runner, pure unit tests in `tests/unit/commander-suggest.test.ts`, style of `tests/unit/scoring.test.ts` (factory helpers, `node:test` + `assert/strict`, relative imports).
- Commits: conventional prefix + trailer line `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- OpenWolf: update `.wolf/anatomy.md` for new files; append `.wolf/memory.md` lines (format `| HH:MM | wat | files | uitkomst | ~tokens |`).

---

### Task 1: Pure scoring module `commander-suggest.ts`

**Files:**
- Create: `lib/collection/commander-suggest.ts`
- Test: `tests/unit/commander-suggest.test.ts`

**Interfaces:**
- Consumes: `SynergyTag` from `lib/collection/synergy/tagger`; `fitsColorIdentity` from `lib/collection/upgrade-scanner`.
- Produces (later tasks import these exact names):

```ts
export type OwnedOracleCard = {
  oracleId: string
  name: string
  typeLine: string
  oracleText: string
  colorIdentity: string[]        // e.g. ['G','W']
  keywords: string[]
  ownedQty: number
  freeQty: number
  tags: { tag: SynergyTag; weight: number }[]
}
export type CommanderCandidate = OwnedOracleCard   // lookup mode may pass ownedQty/freeQty 0
export type SuggestOptions = { freeOnly: boolean }
export type BucketCoverage = { bucket: 'ramp' | 'card_draw' | 'removal' | 'board_wipe' | 'creatures' | 'filler'; owned: number; ideal: number }
export type ThemeFacts = { tribal: { type: string; count: number } | null; keywordOverlap: string[] }
export type CommanderSuggestion = {
  commander: { oracleId: string; name: string; colorIdentity: string[] }
  score: number                  // completeness*0.8 + themeBoost, 1 decimal
  completeness: number           // 0–100
  themeBoost: number             // 0–20 (capped)
  ownedPlayable: number          // nonbasic in-identity pool size (excl. commander)
  lockedCount: number            // pool cards only available from existing decks
  buckets: BucketCoverage[]
  themeFacts: ThemeFacts
  ownsCommander: boolean
  commanderIsFree: boolean
}
export function isCommanderEligible(typeLine: string, oracleText: string): boolean
export function scoreCommander(commander: CommanderCandidate, collection: OwnedOracleCard[], opts: SuggestOptions): CommanderSuggestion
export function suggestCommanders(collection: OwnedOracleCard[], opts: SuggestOptions): CommanderSuggestion[]
```

**Scoring rules (exact — from the spec):**
- Eligible: `/legendary/i` AND `/creature/i` in type_line, OR `/can be your commander/i` in oracle_text.
- Pool for a commander: collection cards (excluding the commander's own oracleId) with `fitsColorIdentity(card.colorIdentity, commander.colorIdentity)`, excluding basics (`/basic land/i.test(typeLine)`), and — when `freeOnly` — `freeQty > 0`; otherwise `ownedQty > 0`. `lockedCount` = pool cards with `freeQty === 0` (whole-collection mode; 0 in freeOnly mode by construction).
- Ideal profile (constant `IDEAL_PROFILE`, exported for the UI):

```ts
export const IDEAL_PROFILE: { bucket: BucketCoverage['bucket']; ideal: number; weight: number }[] = [
  { bucket: 'ramp',       ideal: 10, weight: 0.20 },
  { bucket: 'card_draw',  ideal: 10, weight: 0.20 },
  { bucket: 'removal',    ideal:  8, weight: 0.15 },
  { bucket: 'board_wipe', ideal:  3, weight: 0.05 },
  { bucket: 'creatures',  ideal: 25, weight: 0.25 },
  { bucket: 'filler',     ideal: 63, weight: 0.15 },
]
```

- Bucket counts (distinct cards, not quantity-weighted — Commander is singleton): `ramp/card_draw/removal/board_wipe` = pool cards carrying that `SynergyTag`; `creatures` = `/creature/i` in typeLine; `filler` = total pool size. `completeness = round(Σ weight × min(owned, ideal)/ideal × 100, 1 decimal)`.
- Theme boost (cap 20 total): **tribal** — extract creature subtypes of pool creatures (`typeLine.split(/[—-]/)[1]`, whitespace-split words); for each subtype owned ≥ 5 times (distinct cards), if the commander's oracle_text contains the subtype as a word — singular OR English plural via a small pluralizer: `sub+'s'`, `sub+'es'`, `f/fe→ves` (Elf→Elves, Wolf→Wolves, Dwarf→Dwarves), consonant+`y`→`ies` (Harpy→Harpies), all word-bounded and case-insensitive — it is a tribal fact; take the highest-count one; boost `min(count, 30) / 30 * 15`. **Keywords** — commander keywords shared by ≥ 8 pool cards → `keywordOverlap`; +2.5 per keyword, cap 5.
- `score = round(completeness * 0.8 + themeBoost, 1)`. `suggestCommanders` = filter collection on eligibility (freeOnly ⇒ commander `freeQty > 0`, else `ownedQty > 0`), score each, sort score desc then name asc.
- `ownsCommander = commander.ownedQty > 0`; `commanderIsFree = commander.freeQty > 0`.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/commander-suggest.test.ts`:

```ts
// Buildable-commanders scoring (lib/collection/commander-suggest) — pure,
// deterministic: completeness over IDEAL_PROFILE buckets + capped theme boost.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isCommanderEligible,
  scoreCommander,
  suggestCommanders,
  type OwnedOracleCard,
} from '../../lib/collection/commander-suggest'
import type { SynergyTag } from '../../lib/collection/synergy/tagger'

let n = 0
function card(over: Partial<OwnedOracleCard> = {}): OwnedOracleCard {
  n += 1
  return {
    oracleId: `o-${n}`,
    name: `Card ${n}`,
    typeLine: 'Creature — Human',
    oracleText: '',
    colorIdentity: ['G'],
    keywords: [],
    ownedQty: 1,
    freeQty: 1,
    tags: [],
    ...over,
  }
}
const tag = (t: SynergyTag) => [{ tag: t, weight: 2 }]
const cmdr = (over: Partial<OwnedOracleCard> = {}) =>
  card({ name: 'Test General', typeLine: 'Legendary Creature — Elf Druid', colorIdentity: ['G'], ...over })

test('eligibility: legendary creatures and "can be your commander" cards', () => {
  assert.equal(isCommanderEligible('Legendary Creature — Elf', ''), true)
  assert.equal(isCommanderEligible('Creature — Elf', ''), false)
  assert.equal(isCommanderEligible('Legendary Planeswalker — Teferi', 'Teferi can be your commander.'), true)
  assert.equal(isCommanderEligible('Legendary Enchantment', ''), false)
})

test('pool respects color identity and excludes basics and the commander itself', () => {
  const c = cmdr()
  const inColor = card({ tags: tag('ramp') })
  const offColor = card({ colorIdentity: ['R'] })
  const basic = card({ name: 'Forest', typeLine: 'Basic Land — Forest' })
  const s = scoreCommander(c, [c, inColor, offColor, basic], { freeOnly: true })
  assert.equal(s.ownedPlayable, 1)
})

test('freeOnly excludes cards locked in decks; whole-collection counts them as locked', () => {
  const c = cmdr()
  const free = card({})
  const locked = card({ freeQty: 0 })
  const sFree = scoreCommander(c, [free, locked], { freeOnly: true })
  const sAll = scoreCommander(c, [free, locked], { freeOnly: false })
  assert.equal(sFree.ownedPlayable, 1)
  assert.equal(sFree.lockedCount, 0)
  assert.equal(sAll.ownedPlayable, 2)
  assert.equal(sAll.lockedCount, 1)
})

test('completeness follows the ideal profile weights', () => {
  const c = cmdr()
  // Exactly the ramp ideal (10 ramp cards), nothing else: creatures bucket also
  // counts them (they are creatures), filler counts all 10.
  const pool = Array.from({ length: 10 }, () => card({ tags: tag('ramp') }))
  const s = scoreCommander(c, pool, { freeOnly: true })
  // ramp 10/10*0.20 + creatures 10/25*0.25 + filler 10/63*0.15 = 0.2+0.1+0.0238 → 32.4
  assert.equal(s.completeness, 32.4)
})

test('tribal boost fires when the commander names a subtype you own in bulk', () => {
  const c = cmdr({ oracleText: 'Other Elves you control get +1/+1.' })
  const elves = Array.from({ length: 30 }, () => card({ typeLine: 'Creature — Elf' }))
  const s = scoreCommander(c, elves, { freeOnly: true })
  assert.equal(s.themeFacts.tribal?.type, 'Elf')
  assert.equal(s.themeFacts.tribal?.count, 30)
  assert.equal(s.themeBoost, 15)
})

test('theme boost is capped at 20', () => {
  const c = cmdr({ oracleText: 'Other Elves you control get +1/+1.', keywords: ['Trample', 'Haste'] })
  const elves = Array.from({ length: 30 }, () =>
    card({ typeLine: 'Creature — Elf', keywords: ['Trample', 'Haste'] }))
  const s = scoreCommander(c, elves, { freeOnly: true })
  assert.equal(s.themeBoost, 20) // 15 tribal + 2×2.5 keywords, capped
})

test('lookup mode: an unowned commander scores the same pool, with ownership facts', () => {
  const owned = cmdr()
  const unowned = cmdr({ name: 'Store Shelf General', ownedQty: 0, freeQty: 0 })
  const pool = Array.from({ length: 8 }, () => card({}))
  const a = scoreCommander(owned, pool, { freeOnly: true })
  const b = scoreCommander(unowned, pool, { freeOnly: true })
  assert.equal(a.completeness, b.completeness)
  assert.equal(a.ownsCommander, true)
  assert.equal(b.ownsCommander, false)
  assert.equal(b.commanderIsFree, false)
})

test('suggestCommanders: freeOnly requires a free commander, ordering is deterministic', () => {
  const strong = cmdr({ name: 'Aaa Strong' })
  const lockedCmdr = cmdr({ name: 'Locked General', freeQty: 0 })
  const weak = cmdr({ name: 'Bbb Weak', colorIdentity: ['W'] })
  const pool = Array.from({ length: 12 }, () => card({ tags: tag('ramp') }))
  const sugFree = suggestCommanders([strong, lockedCmdr, weak, ...pool], { freeOnly: true })
  assert.deepEqual(sugFree.map((s) => s.commander.name).slice(0, 2), ['Aaa Strong', 'Bbb Weak'])
  assert.ok(!sugFree.some((s) => s.commander.name === 'Locked General'))
  const sugAll = suggestCommanders([strong, lockedCmdr, weak, ...pool], { freeOnly: false })
  assert.ok(sugAll.some((s) => s.commander.name === 'Locked General'))
})
```


- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- unit/commander-suggest`
Expected: FAIL — cannot find module `../../lib/collection/commander-suggest`.

- [ ] **Step 3: Implement `lib/collection/commander-suggest.ts`**

Implement exactly the interfaces and rules from the header of this task. Skeleton:

```ts
// Buildable commanders (phase 1) — deterministic scoring of "which commander
// decks can this collection support". Pure functions; the server loader feeds
// OwnedOracleCard shapes in, the Advisor renders CommanderSuggestion out.
// Spec: docs/superpowers/specs/2026-07-29-buildable-commanders-design.md

import type { SynergyTag } from './synergy/tagger'
import { fitsColorIdentity } from './upgrade-scanner'

// … types from the Interfaces block, verbatim …

export function isCommanderEligible(typeLine: string, oracleText: string): boolean {
  if (/legendary/i.test(typeLine) && /creature/i.test(typeLine)) return true
  return /can be your commander/i.test(oracleText)
}

const isBasic = (c: { typeLine: string }) => /basic land/i.test(c.typeLine)

function buildPool(commander: CommanderCandidate, collection: OwnedOracleCard[], opts: SuggestOptions) {
  return collection.filter((c) =>
    c.oracleId !== commander.oracleId &&
    !isBasic(c) &&
    (opts.freeOnly ? c.freeQty > 0 : c.ownedQty > 0) &&
    fitsColorIdentity(c.colorIdentity, commander.colorIdentity),
  )
}
```

Then `scoreCommander` computes buckets (counting rules in the header), completeness, tribal fact (subtype extraction: `typeLine.split(/[—-]/)[1] ?? ''`, split on whitespace; count distinct cards per subtype among pool creatures; match against commander oracle_text with `new RegExp('\\b' + subtype + 's?\\b', 'i')`), keyword overlap, capped boost, rounding to 1 decimal via `Math.round(x * 10) / 10`. `suggestCommanders` filters eligible candidates from the collection and sorts `(b.score - a.score) || a.commander.name.localeCompare(b.commander.name)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- unit/commander-suggest`
Expected: PASS (8 tests). Hand-check the completeness fixture math in the test comment if it fails — adjust the implementation, never the profile constants.

- [ ] **Step 5: Commit**

```bash
git add lib/collection/commander-suggest.ts tests/unit/commander-suggest.test.ts
git commit -m "feat(collection): commander-suggest scoring — completeness + theme boost (buildable commanders phase 1)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Server loader + lookup/scoring API route

**Files:**
- Create: `lib/collection/commander-suggest-data.ts`
- Create: `app/api/collection/commanders/route.ts`
- Modify: none

**Interfaces:**
- Consumes (Task 1): `OwnedOracleCard`, `CommanderSuggestion`, `SuggestOptions`, `scoreCommander`, `suggestCommanders`, `isCommanderEligible`.
- Produces:
  - `loadOwnedOracleCards(supabase: SupabaseClient, userId: string): Promise<OwnedOracleCard[]>` — joins `co_card_availability` (owned/free per oracle_id) with `co_card_oracle` (name/type_line/oracle_text/color_identity/keywords) and `co_card_tags` (tags per oracle_id, chunked `in()` queries via the existing `deck-loader.ts` helpers — `IN_CHUNK=100`; buglog shows 300 already hit "URI too long"). Mapping only — no scoring logic.
  - `searchCommanderCatalog(supabase: SupabaseClient, query: string): Promise<{ oracleId: string; name: string; typeLine: string; colorIdentity: string[] }[]>` — `co_card_oracle` where `name ilike %query%`, filtered in TS with `isCommanderEligible`, limit 12, ordered by name.
  - `loadCommanderCandidate(supabase: SupabaseClient, userId: string, oracleId: string): Promise<OwnedOracleCard | null>` — one `co_card_oracle` row + the user's availability row (ownedQty/freeQty 0 when absent) + tags.
- Route `GET /api/collection/commanders?q=<text>` → `{ results: [...] }` (search). `GET /api/collection/commanders?oracleId=<id>&freeOnly=<true|false>` → `{ suggestion: CommanderSuggestion }` (lookup scoring: loader + `scoreCommander` against `loadOwnedOracleCards`). 401 without auth; 400 without `q`/`oracleId`. Follow the auth pattern of the existing `app/api/collection/search/route.ts` (read it first and mirror its `createClient`/claims handling verbatim).

- [ ] **Step 1: Implement the loader** (mapping-only; column names exactly: `owned_qty`, `free_qty`, `color_identity`, `type_line`, `oracle_text`, `keywords`).
- [ ] **Step 2: Implement the route** (thin: parse params, call loader + Task 1 functions, `NextResponse.json`).
- [ ] **Step 3: Verify** — `npx tsc --noEmit` and `npx eslint lib/collection/commander-suggest-data.ts app/api/collection/commanders/route.ts` clean; `npm test -- unit/commander-suggest` still green (no behavior change). No unit tests for the loader (mapping only, no logic) — the end-to-end check happens in Task 4 against the real local collection.
- [ ] **Step 4: Commit**

```bash
git add lib/collection/commander-suggest-data.ts app/api/collection/commanders/route.ts
git commit -m "feat(collection): commander suggest loader + lookup API route

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Advisor UI — section, toggle, detail, lookup, Start this deck

**Files:**
- Create: `components/collection/BuildableCommanders.tsx` (client component)
- Create: `app/api/collection/commanders/start-deck/route.ts`
- Modify: `app/collection/advisor/page.tsx` (add data load + section)

**Interfaces:**
- Consumes: Task 1 types; Task 2 loader (server side) and `/api/collection/commanders` (client side).
- Produces: `BuildableCommanders({ freeSuggestions, allSuggestions }: { freeSuggestions: CommanderSuggestion[]; allSuggestions: CommanderSuggestion[] })` — the advisor page passes BOTH toggle variants (computed server-side from one `loadOwnedOracleCards` call; the toggle is a pure client switch, no refetch). `POST /api/collection/commanders/start-deck` body `{ oracleId: string, name: string }` → `{ deckId: string }`.

**Behavior (from the spec §1):**
- Section "Commanders you can build" below the existing advisor sections: top 10 rows (+ "Show more" reveals the rest, client-side), each row: name, color identity pips, explanation line built from the suggestion: `"{ownedPlayable} free playable cards · strong in {top-2 buckets by owned/ideal} · {tribal.count} {tribal.type}s"` (omit absent parts; in whole-collection mode append `" · {lockedCount} in decks"`).
- Toggle `Only free cards / Whole collection` (default free) — switches between the two prop arrays. In whole-collection mode a suggestion whose `commanderIsFree === false` gets a small "commander in a deck" chip on its row (spec: locked commanders allowed there, but labeled).
- Row click expands an inline detail: per-bucket bars `owned/ideal` from `suggestion.buckets`, biggest gaps named (lowest owned/ideal ratio first), theme facts, and **Start this deck**.
- Lookup: input "Check a specific commander…" (debounced 300ms) → `GET ?q=` results dropdown → pick → `GET ?oracleId=&freeOnly=` → render the SAME detail panel; when `!ownsCommander`, show the line "You don't own this commander yet — {ownedPlayable} playable cards are waiting for it."
- **Start this deck** POSTs, then `router.push('/collection/decks/' + deckId)`.
- Empty states per spec (no collection → link to `/collection/import`; no owned eligible commanders → explanatory text; lookup always shown).
- Styling: match the surrounding advisor sections (read the existing sections in `app/collection/advisor/page.tsx` and reuse their section header / card classes — binder theme, no new design language).

**start-deck route:** mirror `lib/collection/import-deck.ts:56-77`: insert `co_decks` `{ user_id, name, commander_oracle_id: oracleId }`, then one `co_deck_cards` row `{ deck_id, oracle_id: oracleId, quantity: 1, is_commander: true }`; on card-insert failure delete the deck row (same cleanup pattern); return `{ deckId }`.

- [ ] **Step 1: Implement the start-deck route** (auth pattern as in Task 2).
- [ ] **Step 2: Implement `BuildableCommanders.tsx`** ('use client'; props as above; local state: `freeOnly` (true), `expandedId`, `showAll`, lookup `query/results/picked`; fetches via `fetch('/api/collection/commanders?...')`).
- [ ] **Step 3: Wire the advisor page** — in the existing `Promise.all`, add `loadOwnedOracleCards(supabase, userId)`; compute `suggestCommanders(owned, { freeOnly: true })` and `{ freeOnly: false }`; render `<BuildableCommanders …/>` as a new `<section>` below the last existing section.
- [ ] **Step 4: Verify** — `npx tsc --noEmit`, `npx eslint components/collection/BuildableCommanders.tsx app/api/collection/commanders/start-deck/route.ts "app/collection/advisor/page.tsx"`, `npm test -- unit/commander-suggest`.
- [ ] **Step 5: Commit**

```bash
git add components/collection/BuildableCommanders.tsx app/api/collection/commanders/start-deck/route.ts app/collection/advisor/page.tsx
git commit -m "feat(collection): Buildable Commanders section on Advisor — toggle, lookup, start deck

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: End-to-end verification + OpenWolf bookkeeping

**Files:**
- Modify: `.wolf/anatomy.md`, `.wolf/memory.md`

- [ ] **Step 1: Full gates** — `npm test` (full suite green), `npx eslint .` (only the 2 known pre-existing `doc/*.js` errors), `npx tsc --noEmit`.
- [ ] **Step 2: Real-collection check** — start the dev server, open `/collection/advisor` logged in as Jordy's local account. **The local DB (:54322) is Jordy's real test environment: read-only — never delete/reset rows.** Verify: section renders < 1s (check server timing in dev output), explanation lines read sensibly, toggling switches numbers, lookup finds an unowned commander and scores it, "Start this deck" creates a deck and navigates (creating a deck is an allowed write — it's the feature; do NOT delete existing decks). If the account has no collection, report DONE_WITH_CONCERNS with what blocked the check instead of seeding data.
- [ ] **Step 3: OpenWolf** — anatomy entries for the three new code files + test file (one line each, style of existing entries); memory line `| HH:MM | Buildable commanders fase 1 gebouwd (scoring, loader, advisor-sectie, lookup, start-deck) | lib/collection/commander-suggest*, BuildableCommanders.tsx | suite groen, live check ok | ~Nk |` (fill actual time/tokens).
- [ ] **Step 4: Commit**

```bash
git add .wolf/anatomy.md .wolf/memory.md
git commit -m "chore(wolf): log buildable commanders phase 1

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
