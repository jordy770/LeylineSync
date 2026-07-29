# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-07-29T22:16:52.699Z
> Files: 19 tracked | Anatomy hits: 0 | Misses: 0

## ../../.claude/jobs/adcb6c2b/tmp/


## ../../.claude/jobs/ca267fb9/tmp/


## ../../.claude/jobs/ca267fb9/tmp/fixdrafts/


## ../../.claude/jobs/ca267fb9/tmp/lowfix/


## ../../.claude/plans/


## ../../.claude/projects/C--Users-Jordy-dev-LeylineSync/5705253f-fa3a-4781-b264-b9ec72069b46/workflows/scripts/


## ../../.claude/projects/C--Users-Jordy-dev-LeylineSync/cbab7504-eb67-46c3-a9ec-5892512d9617/workflows/scripts/


## ../../.claude/projects/C--Users-Jordy-dev-LeylineSync/memory/


## ../../.cloudflared/


## ../../AppData/Local/Temp/claude/C--Users-Jordy-dev-LeylineSync/29ade7df-e915-4e92-91d0-74481e09da2e/scratchpad/


## ../../AppData/Local/Temp/claude/C--Users-Jordy-dev-LeylineSync/5705253f-fa3a-4781-b264-b9ec72069b46/scratchpad/


## ../../AppData/Local/Temp/claude/C--Users-Jordy-dev-LeylineSync/6cbaf238-ecfd-454f-9738-19dff50029e0/scratchpad/


## ../../AppData/Local/Temp/claude/C--Users-Jordy-dev-LeylineSync/a403f535-8b14-4f77-9426-b571a70d18cf/scratchpad/


## ../../AppData/Local/Temp/claude/C--Users-Jordy-dev-LeylineSync/b3467b9f-c3ab-4823-9620-fb93c878b451/scratchpad/


## ../../AppData/Local/Temp/claude/C--Users-Jordy-dev-LeylineSync/bf0a6454-491f-4097-8309-b87718788394/scratchpad/

- `decks-verify.mjs` — Task 4 verification: authenticated screenshots + functional click-through of /decks binder-restyle. (~4892 tok)
- `decks-verify2.mjs` — Task 4 verification round 2: fixes for the functional click-through's false negatives (~3176 tok)

## ../../AppData/Local/Temp/claude/C--Users-Jordy-dev-LeylineSync/cbab7504-eb67-46c3-a9ec-5892512d9617/scratchpad/


## ../../AppData/Local/Temp/claude/C--Users-Jordy-dev-LeylineSync/cbab7504-eb67-46c3-a9ec-5892512d9617/scratchpad/audit-chunks/


## ../../AppData/Local/Temp/claude/C--Users-Jordy-dev-LeylineSync/e378a9bd-21e1-45b0-8890-278da934081a/scratchpad/


## ./


## .claude/


## .claude/projects/c--Users-Jordy-dev-LeylineSync/memory/


## .claude/rules/


## .claude/workflows/


## .git/


## .github/workflows/


## .superpowers/sdd/


## .superpowers/sdd/2026-07-28-spotlight-viewport-fit/


## .superpowers/sdd/2026-07-29-buildable-commanders/


## .superpowers/sdd/2026-07-29-deck-generation/


## .superpowers/sdd/2026-07-29-decks-editor-restyle/

- `task-1-report.md` — Task 1 Report — Layout swap: deckbox list left, Forge-new-deck collapsed (~1407 tok)
- `task-2-report.md` — Task 2 report — editor bands 1–3 (header band, insights strip, unified toolbar) (~2759 tok)
- `task-3-report.md` — Task 3 report — band 4: view controls, grid, tiles, list view, preview chrome (~1660 tok)
- `task-4-report.md` — Task 4 report — visual + functional verification, OpenWolf bookkeeping (~2782 tok)

## Phase 1 Tier-B scry (added 2026-06-02)


## app/


## app/api/cards/generate-behavior/


## app/api/collection/commanders/


## app/api/collection/commanders/generate/


## app/api/collection/commanders/save-deck/


## app/api/collection/commanders/start-deck/


## app/api/collection/deck-containers/


## app/api/collection/import/


## app/api/collection/move-card/


## app/api/collection/resolve-conflict/


## app/api/collection/search/


## app/api/conflicts/


## app/api/decks/[id]/


## app/api/decks/[id]/analysis/


## app/api/decks/[id]/buy/


## app/api/decks/[id]/combos/


## app/api/decks/[id]/commander/


## app/api/decks/[id]/mulligan/


## app/api/decks/[id]/play/


## app/api/decks/[id]/pull-list/


## app/api/decks/[id]/recommend/


## app/api/decks/[id]/swaps/


## app/api/decks/[id]/sync/


## app/api/decks/[id]/upgrades/


## app/api/decks/import/


## app/api/games/[id]/analyze/


## app/api/intelligence/classify/


## app/api/trade/


## app/auth/confirm/


## app/auth/error/


## app/auth/forgot-password/


## app/auth/login/


## app/auth/sign-up-success/


## app/auth/sign-up/


## app/auth/update-password/


## app/board/[id]/


## app/cards/behavior/


## app/collection/


## app/collection/advisor/


## app/collection/binders/


## app/collection/conflicts/


## app/collection/decks/[id]/


## app/collection/decks/import/


## app/collection/games/


## app/collection/import/


## app/collection/insights/


## app/collection/intelligence/


## app/collection/playground/


## app/collection/search/


## app/controller-style-lab/


## app/controller/[id]/


## app/decks/


## app/join/[id]/


## app/judge/[id]/


## app/manifest.webmanifest/


## app/protected/


## app/style-guide/


## app/tv/


## components/

- `DeckInsights.tsx` — deck stats panel (curve/pips/types/legality); binder tokens, gold curve bars (~1800 tok)
- `DeckManager.tsx` — /decks game-side deck editor: deckbox list (gold active state) + collapsible Forge form + renders DeckHeaderBand/DeckInsightsStrip/toolbar + grid/list/tiles/preview/behavior-editor modals; binder-restyled jul '26 (task 4 verified: gold deckbox active state OK, no slate-gray outside CardCatalogPicker; found 2 bugs — grid-tile remove btn `bg-[var(--danger)]/80` compiles to no rule under Tailwind 3.4 [hex var, not RGB triplet] so it's transparent until hover, and status/error toasts only render inside the Forge panel so they're invisible whenever an existing deck is selected) (~10650 tok)

## components/board/


## components/collection/


## components/controller/


## components/deck/

- `DeckHeaderBand.tsx` — Edit Deck band 1: commander-art placeholder, name, status counts, legality chip (click amber pill to see issues) (~650 tok)
- `DeckInsightsStrip.tsx` — Edit Deck band 2: collapsible strip wrapping DeckInsights; summary = curve-peak MV + creature count (~450 tok)

## components/judge/


## components/layout/


## components/tutorial/


## components/ui/


## docs/


## docs/collection-optimizer/


## docs/commander-decks/


## docs/superpowers/plans/

- `2026-07-29-decks-editor-restyle.md` — /decks Editor Binder-Restyle + Herindeling — Implementation Plan (~2736 tok)

## docs/superpowers/specs/

- `2026-07-29-deck-page-structure-design.md` — Deck Page Structure (Improve & Beautify — Phase A: IA) — Design Spec (~1100 tok)
- `2026-07-29-decks-editor-restyle-design.md` — /decks Editor — Binder Restyle + Herindeling — Design Spec (~1338 tok)

## lib/


## lib/collection/


## lib/collection/parsers/


## lib/collection/synergy/


## lib/game/


## lib/intelligence/


## lib/intelligence/rules/


## lib/supabase/


## mockups/

- `deck-page-structure.html` — Mockup — Deck Page Structure (Phase A) (~4405 tok)
- `decks-editor-restyle.html` — Mockup — /decks editor: binder-restyle + herindeling (~4343 tok)

## public/


## scripts/


## supabase/


## supabase/functions/spawn-deck/


## supabase/functions_src/


## supabase/migrations/


## supabase/migrations/ (200-215, 2026-06-10)


## tests/


## tests/feature/


## tests/fixtures/


## tests/harness/


## tests/regression/


## tests/unit/


## vercel/


## vercel/app/


## vercel/components/


## vercel/components/mtg/


## vercel/components/ui/


## vercel/hooks/


## vercel/lib/


## vercel/lib/mtg/


## vercel/styles/

