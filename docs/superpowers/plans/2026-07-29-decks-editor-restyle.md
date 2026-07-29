# /decks Editor Binder-Restyle + Herindeling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `components/DeckManager.tsx` (the `/decks` editor) drops its legacy slate/amber styling for the binder theme and is restructured to the approved mockup (`mockups/decks-editor-restyle.html`): deckbox list left, editor right in four bands, card grid as the star.

**Architecture:** Pure presentational refactor — same state, same handlers, same data calls. Class swaps to binder tokens plus JSX re-arrangement; two small extractions (`DeckHeaderBand`, `DeckInsightsStrip`). No API/data/migration changes. Spec: `docs/superpowers/specs/2026-07-29-decks-editor-restyle-design.md`.

**Tech Stack:** React client components, Tailwind arbitrary values + CSS vars from `.binder-shell` (`app/globals.css:266-291`), Outfit/Karla via the existing `font-display`/`font-rules` classes.

## Global Constraints

- **Zero behavior changes:** every existing handler stays wired — import deck (incl. missing-lines report + status/error messages), refresh, select/delete deck, add card (CardCatalogPicker + quantity), ±quantity, set commander, edit behavior (popup + closeBehavior refresh), batch Generate behavior (+ progress), Sample hand, Copy as text, Clone, preview modal, grid/list toggle, sort keys, needs-only filter, legality display.
- **Binder tokens only** — after this plan `grep -c "slate-" components/DeckManager.tsx components/DeckInsights.tsx` MUST print `0` for both (currently 47 and 12). Amber utility classes likewise replaced by `var(--gold-bright)`/`var(--frame-gold)`/`var(--warn)` per the mockup; status colors: scripted `var(--cast)`, vanilla `var(--text-dim)`, needs `var(--warn)`, danger `var(--danger)`.
- Panel look = the mockup's `.panel`: `background: var(--ink-2); border-radius: 16px; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.05), 0 14px 34px rgba(0,0,0,0.45)` (matches `.binder-shell .leyline-glass-panel`). Reuse `components/collection/ui.tsx`'s `Panel` ONLY if it renders exactly this and imports cleanly outside `components/collection` — otherwise inline the classes (do not fork ui.tsx).
- The mockup is the visual source of truth: `mockups/decks-editor-restyle.html`. Open it in a browser while working.
- Presentational work: no unit-test harness exists for components — TDD not applicable (per repo precedent); each task gates on `npx tsc --noEmit`, `npx eslint <touched files>`, `npx next build`, and the unchanged unit suites; visual + functional verification is Task 4.
- No LLM, no migrations, files limited to: `components/DeckManager.tsx`, `components/DeckInsights.tsx`, new `components/deck/DeckHeaderBand.tsx`, new `components/deck/DeckInsightsStrip.tsx`, and (only if needed for the shell) `app/decks/page.tsx`.
- Commits: conventional prefix + trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. OpenWolf bookkeeping in Task 4.

---

### Task 1: Layout swap — deckbox list left, Forge-new-deck collapsed

**Files:**
- Modify: `components/DeckManager.tsx:343-434` (outer grid, Create Deck section, Your Decks section)

**Interfaces:**
- Consumes: existing state (`decks`, `selectedDeckId`, `deckNameInput`, `decklistInput`, `missingLines`, `statusMessage`, `errorMessage`, `isWorking`) and handlers (`handleImportDeck`, `refreshDecks`, `setSelectedDeckId`).
- Produces: new local state `const [forgeOpen, setForgeOpen] = useState(false)` that Tasks 2–3 leave untouched.

Behavior (mockup): outer grid becomes `grid gap-4 md:grid-cols-[250px_minmax(0,1fr)] items-start`. LEFT panel: heading "Your spellbook" (`font-display text-[11px] uppercase tracking-[0.28em]` in `var(--frame-gold)`), deckbox rows — name (13.5px semibold), subtitle `{card_count} kaarten` (11px `var(--text-faint)`), active row `border-l-4` `var(--frame-gold)` + `rgba(255,212,121,0.08)` wash, inactive `rgba(255,255,255,0.03)`; the raw deck-id line disappears from the row (it was debug noise); Refresh stays as a small text action in the heading row. Beneath the rows: `+ Forge new deck (paste a list)` gold text button toggling `forgeOpen`.
- Color pips per deckbox: OMIT in this phase — `DeckSummary` (game-side) carries no color identity and adding data plumbing violates the presentational scope. Note the deviation from the mockup in the commit body (mockup shows pips; phase B can add them with the art work).
- RIGHT area: when `forgeOpen`, render the existing Create Deck form (all fields, missing-lines block, status/error messages — handlers unchanged) as a binder panel titled "Forge new deck" with a `Cancel` text button (`setForgeOpen(false)`); after a successful import (`handleImportDeck` resolves without error) close it. When `!forgeOpen && !selectedDeck`, show an empty-state panel ("Select a deck or forge a new one"). When a deck is selected, the editor (Tasks 2–3) renders.
- All slate/amber classes in the touched region swap to binder tokens per Global Constraints.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Verify** — `npx tsc --noEmit`; `npx eslint components/DeckManager.tsx`; `npx next build`.
- [ ] **Step 3: Commit** — `feat(decks): binder deckbox list + collapsible forge form` + trailer (note the omitted pips in the body).

---

### Task 2: Editor bands 1–3 — header, insights strip, toolbar

**Files:**
- Create: `components/deck/DeckHeaderBand.tsx`
- Create: `components/deck/DeckInsightsStrip.tsx`
- Modify: `components/DeckManager.tsx:436-543` (Edit Deck header/insights/legality/tools/Add Card)
- Modify: `components/DeckInsights.tsx` (class swaps only — 12 slate- classes → binder tokens; gold curve bars per the mockup)

**Interfaces:**
- Produces:
  - `DeckHeaderBand({ deck, statusCounts, legality }: { deck: DeckDetail; statusCounts: { scripted: number; vanilla: number; needs: number }; legality: DeckLegality | null })` — band 1: commander-art placeholder block (rounded rect, `linear-gradient(140deg,#7a4a25,#37502a 55%,#24333f)` + ★, per the mockup; a code comment marks it as the phase-B art slot), deck name (`font-display` 19px), status line with the three colored counts, legality chip right-aligned: green pill when legal; when not legal an amber pill `⚠ Not Commander-legal` that toggles open the existing issues list (`useState` inside the band).
  - `DeckInsightsStrip({ cards, commanderCard }: props identical to today's DeckInsights call at DeckManager.tsx:460-463)` — collapsible strip (collapsed default): summary line derived from the deck (`curve piekt op MV {mode}` · `{n} creatures` — compute mode-of-curve and creature count locally, both cheap) + chevron; expanded body renders the restyled `<DeckInsights …/>`.
- Consumes: types `DeckDetail`, `DeckLegality` as already imported in DeckManager; `getCardConfigStatus` for the counts (computed in DeckManager and passed in, keeping the band pure-presentational).

Behavior: DeckManager's Edit Deck section header block (title, counts paragraph, DeckInsights, legality) is REPLACED by `<DeckHeaderBand …/>` + `<DeckInsightsStrip …/>`; the tools row + Add Card merge into ONE toolbar row (tools left: ✨ Generate behavior (n) gold-outline with the batch progress span, Sample hand, Copy as text, Clone; Add Card right: `CardCatalogPicker` + quantity input + gold `+ Add` primary button `linear-gradient(160deg,#f2c96a,#d99a2b)` dark text). All handlers unchanged.

- [ ] **Step 1: Implement the two components + rewire DeckManager.**
- [ ] **Step 2: Restyle DeckInsights.tsx** (class swaps; gold bars `linear-gradient(180deg, var(--gold-bright), var(--frame-gold))`; check `grep -c "slate-" components/DeckInsights.tsx` → 0).
- [ ] **Step 3: Verify** — tsc; eslint on the four files; `npx next build`.
- [ ] **Step 4: Commit** — `feat(decks): header band + collapsible insights strip + unified toolbar (binder)` + trailer.

---

### Task 3: Band 4 — view controls, grid, tiles, list view, preview chrome

**Files:**
- Modify: `components/DeckManager.tsx:545-989` (list controls, DeckGrid, DeckCardTile, list view, preview modal, sample-hand display)

Behavior (mockup): view controls become segmented toggles (`Grid/List`, sort `Name/MV/Type/Behavior`, needs-only checkbox right) — same state (`viewMode`, `sortKey`, `showNeedsOnly`), new chrome (segments: 1px `rgba(255,255,255,0.12)` border, active segment `rgba(255,212,121,0.14)` + `var(--gold-bright)`). Group headings: `font-display` 11px uppercase tracked, `var(--text-faint)`, count in `var(--text-dim)`. Tiles: keep the art `aspect-[2/3]` image and every badge/handler; swap chrome — tile background `#1c1e24`, inset ring `rgba(255,255,255,0.07)`, radius 10; commander tile `inset 0 0 0 2px var(--frame-gold)` + `0 0 18px rgba(232,180,76,0.25)` glow (replaces the amber border/ring); ×N badge `rgba(0,0,0,0.72)` pill with `var(--gold-bright)` text; behavior badge colors → `--cast`/`--warn`/`--text-dim` scheme; ± strip `rgba(255,255,255,0.05)` with gold hover. List view mode and the preview modal + sample-hand panel get the same token sweep (structure unchanged). Final sweep: `grep -cE "slate-|amber-" components/DeckManager.tsx` → 0 (legitimate gold accents use tokens, not amber-* utilities).

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Verify** — tsc; `npx eslint components/DeckManager.tsx`; `npx next build`; `grep -c "slate-" components/DeckManager.tsx` → 0.
- [ ] **Step 3: Commit** — `feat(decks): binder card grid, tiles, list view and preview chrome` + trailer.

---

### Task 4: Visual + functional verification, OpenWolf

**Files:**
- Modify: `.wolf/anatomy.md`, `.wolf/memory.md`

- [ ] **Step 1: Gates** — `npm test` (full suite green — nothing here touches engine/unit code, expect the current count), `npx eslint .` (only the 2 known doc/*.js errors), `npx tsc --noEmit`.
- [ ] **Step 2: Visual check** — authenticated screenshots of `/decks` (puppeteer + magic-link method per cerebrum; local dev server) with a commander deck selected, at 1440×900: compare against `mockups/decks-editor-restyle.html`. Assert: four bands in order; card grid starts above the fold; deckboxes left with gold active state; no slate-gray panels anywhere. Screenshot with the Forge form open too.
- [ ] **Step 3: Functional click-through** (UI only, on a TEST deck — the Gishath game-side clone if present, else clone one first via the UI and report it): add a card, +/− quantity, toggle grid/list, sort switch, needs-filter, sample hand, copy as text, expand insights, expand legality issues (if any deck is illegal), open a card preview, open the behavior editor and close it. Each must behave as before.
- [ ] **Step 4: OpenWolf + commit** — anatomy entries (two new `components/deck/*` files + updated DeckManager/DeckInsights lines), memory line, `git add .wolf/... && git commit -m "chore(wolf): log /decks binder-restyle" ` + trailer.
