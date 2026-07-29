# /decks Editor — Binder Restyle + Herindeling — Design Spec

**Date:** 2026-07-29
**Problem:** The deck editor at `/decks` (`components/DeckManager.tsx`, 989
lines) still runs on the legacy slate/amber styling inside a `binder-shell`
page — the July binder restyle skipped this component, so it visually clashes
with the rest of the app. Structurally the "Edit Deck" column stacks six
blocks (status counts, insights, legality, tools, Add Card, view controls)
ABOVE the card grid, burying the page's best content (real card-art tiles).

**Approved direction:** the mockup `mockups/decks-editor-restyle.html` — Jordy
signed off ("ziet er netjes uit"). Visual + structure in ONE pass (they are
inseparable here: the restyle touches every element anyway). A later phase B
adds real Scryfall art crops (commander header art, richer tiles); a possible
phase C covers editing-flow extras. Both out of scope.

## Section 1 — Layout (mirrors the mockup)

Two-column layout stays (`250px`-ish deck list left, editor right; single
column on small screens, as today).

**Left — deck list as deckboxes:** each deck row becomes a "deckbox": name +
card count/format subtitle, 4px gold left border + soft gold wash when active.
(Planning amendment: the mockup's color-identity pips are deferred to phase B —
the game-side `DeckSummary` carries no color data and adding plumbing violates
this phase's presentational scope.) "Forge new deck" (the existing
import-from-text flow) as a gold text action beneath. Functionality unchanged
(select, create, delete stay wired as today).

**Right — editor panel, restructured into four bands:**
1. **Deck header band:** commander-art placeholder block (fixed-size rounded
   rect with a ★; phase B swaps in the real art crop), deck name, one status
   line (`100 kaarten · 78 scripted · 16 vanilla · 6 need behavior` — colored
   per the existing status colors), legality chip right-aligned (`✓
   Commander-legal (N)` green pill, or the existing warning block styled as a
   collapsed amber pill that expands the issues list on click).
2. **Insights strip (collapsible, collapsed by default):** summary line
   ("Insights — curve piekt op MV 3 · 31 creatures · kleuren in balans" —
   derived from the existing `DeckInsights` data), expanding to the current
   DeckInsights content restyled: mana-curve bars in gold, type counts,
   singleton/color-identity checks. The existing `DeckInsights` component is
   restyled and re-parented, not rewritten.
3. **Toolbar:** deck tools left (✨ Generate behavior (n) — gold outline; 🃏
   Sample hand; Copy as text; Clone), Add Card right (existing
   `CardCatalogPicker` + quantity + gold `+ Add` button in one row). Same
   handlers, same batch progress indicator.
4. **Card grid (the star):** view controls as compact segmented toggles
   (Grid/List · sort keys Name/MV/Type/Behavior · "needs behavior" filter
   checkbox), then the existing grouped grid. Tiles keep all functionality
   (×N badge, behavior badge, +/− strip, preview click, CMD tag) restyled to
   binder tokens; the commander tile gets a gold inset frame + glow. The list
   view mode is restyled equivalently.

## Section 2 — Styling rules

- Replace ALL slate/amber utility classes in `DeckManager.tsx` (and its tiles)
  with binder-theme tokens (`var(--ink-2)` panels radius 16 with the standard
  inset+shadow, `--gold-bright`/`--frame-gold` accents, `--text*` scales,
  `--cast`/`--warn`/`--danger` status colors) and the `font-display`
  (Outfit) / `font-rules` (Karla) classes — exactly the `.binder-shell`
  conventions in `app/globals.css` and the look of `components/collection/*`.
- The page (`app/decks/page.tsx`) already provides the binder shell; it needs
  no changes beyond what the component swap requires.
- Modal/preview and the behavior editor entry points keep working; restyle
  their trigger chrome only where it lives inside DeckManager (the behavior
  editor itself is out of scope).

## Section 3 — Code structure & verification

- Extractions from `DeckManager.tsx` where the bands make natural components:
  `components/deck/DeckHeaderBand.tsx`, `components/deck/DeckInsightsStrip.tsx`
  (wrapping the restyled DeckInsights), keep the grid/tiles in place (they are
  already separate functions). Move-only + class swaps; no handler/logic
  changes, no API changes, no migrations, no LLM.
- Verification: full suite + eslint + tsc + `npx next build`; visual
  before/after screenshots of `/decks` (authenticated, puppeteer + magic-link
  method) compared against the mockup — checked for: no slate/amber classes
  left in DeckManager (`grep -c "slate-" components/DeckManager.tsx` → 0),
  four bands present, grid above the fold on 1440×900 with a selected deck,
  all existing actions still wired (add card, ±quantity, sample hand, clone,
  export, generate behavior, preview, set commander, legality).
- Local-DB safety rules apply (read-only; deck edits during manual checks only
  via the UI on a test deck, reported).

## Out of scope

- Phase B: real Scryfall art crops (header + any tile art upgrades), further
  visual flair.
- Phase C: editing-flow extras (multi-select, drag/sort, inline quick-add
  beyond the existing picker).
- The behavior editor UI, card catalog picker internals, deck import flow
  logic, and `/collection/decks/[id]` (explicitly a DIFFERENT page).
