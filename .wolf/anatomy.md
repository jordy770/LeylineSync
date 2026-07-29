# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-07-29T16:26:02.347Z
> Files: 15 tracked | Anatomy hits: 0 | Misses: 0

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

- `task-1-report.md` — Task 1 report: pure generator `deck-generator.ts` (~1845 tok)
- `task-2-report.md` — Task 2 report: loader cmc + gap-buys helper + generate route (~1232 tok)
- `task-3-report.md` — Task 3 report: save-deck route with pure server-side revalidation (~1971 tok)
- `task-4-report.md` — Task 4 report: deck-proposal preview UI in Buildable Commanders panel (~1495 tok)

## Phase 1 Tier-B scry (added 2026-06-02)


## app/


## app/api/cards/generate-behavior/


## app/api/collection/commanders/


## app/api/collection/commanders/generate/

- `route.ts` — POST /api/collection/commanders/generate  body: { oracleId, freeOnly } → { proposal: DeckProposal & (~634 tok)

## app/api/collection/commanders/save-deck/

- `route.ts` — oracle_id → {colorIdentity, typeLine, ownedQty} for the submitted card ids, chunked. (~1715 tok)

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


## components/board/


## components/collection/

- `BuildableCommanders.tsx` — TOP_N; SuggestionDetail now also holds a per-instance deck-proposal preview (Generate decklist → POST generate, Save deck (N) → POST save-deck, Back), refetching on freeOnly flip while a preview is open (~11200 tok)

## components/controller/


## components/judge/


## components/layout/


## components/tutorial/


## components/ui/


## docs/


## docs/collection-optimizer/


## docs/commander-decks/


## docs/superpowers/plans/

- `2026-07-29-deck-generation.md` — Deck Generation from Collection (Phase 2) — Implementation Plan (~3611 tok)

## docs/superpowers/specs/

- `2026-07-29-deck-generation-design.md` — Deck Generation from Collection (Buildable Commanders Phase 2) — Design Spec (~1557 tok)

## lib/


## lib/collection/

- `commander-suggest-data.ts` — Escape ilike wildcards (and the escape character itself) so literal %/_/\ in the query can't alter t (~2922 tok)
- `commander-suggest.ts` — Creature subtypes present on a card's type line. Double-faced/MDFC type (~3061 tok)
- `deck-generator.ts` — Deck proposal generator (buildable commanders, phase 2) — deterministic (~2972 tok)
- `proposal-validate.ts` — Save-deck proposal revalidation — pure server-side re-check of the payload (~988 tok)

## lib/collection/parsers/


## lib/collection/synergy/


## lib/game/


## lib/intelligence/


## lib/intelligence/rules/


## lib/supabase/


## mockups/


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

- `deck-generator.test.ts` — Deck proposal generator (lib/collection/deck-generator) — pure, deterministic (~3824 tok)
- `proposal-validate.test.ts` — Save-deck proposal revalidation (lib/collection/proposal-validate) — pure, (~2055 tok)

## vercel/


## vercel/app/


## vercel/components/


## vercel/components/mtg/


## vercel/components/ui/


## vercel/hooks/


## vercel/lib/


## vercel/lib/mtg/


## vercel/styles/

