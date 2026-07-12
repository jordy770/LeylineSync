# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-07-12T00:49:48.425Z
> Files: 9 tracked | Anatomy hits: 0 | Misses: 0

## ../../.claude/jobs/adcb6c2b/tmp/


## ../../.claude/plans/


## ../../.claude/projects/C--Users-Jordy-dev-LeylineSync/5705253f-fa3a-4781-b264-b9ec72069b46/workflows/scripts/


## ../../.claude/projects/C--Users-Jordy-dev-LeylineSync/memory/


## ../../.cloudflared/


## ../../AppData/Local/Temp/claude/C--Users-Jordy-dev-LeylineSync/29ade7df-e915-4e92-91d0-74481e09da2e/scratchpad/


## ../../AppData/Local/Temp/claude/C--Users-Jordy-dev-LeylineSync/5705253f-fa3a-4781-b264-b9ec72069b46/scratchpad/


## ../../AppData/Local/Temp/claude/C--Users-Jordy-dev-LeylineSync/6cbaf238-ecfd-454f-9738-19dff50029e0/scratchpad/


## ../../AppData/Local/Temp/claude/C--Users-Jordy-dev-LeylineSync/a403f535-8b14-4f77-9426-b571a70d18cf/scratchpad/


## ../../AppData/Local/Temp/claude/C--Users-Jordy-dev-LeylineSync/b3467b9f-c3ab-4823-9620-fb93c878b451/scratchpad/


## ./


## .claude/


## .claude/projects/c--Users-Jordy-dev-LeylineSync/memory/


## .claude/rules/


## .claude/workflows/


## .git/


## .github/workflows/


## Phase 1 Tier-B scry (added 2026-06-02)


## app/


## app/api/cards/generate-behavior/


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

- `ControllerListV5.tsx` — The mana an untapped card auto-produces when it has exactly one simple (~72054 tok)
- `GameBoard.tsx` — GameBoard (~10221 tok)

## components/board/


## components/collection/


## components/controller/

- `CardActionSheet.tsx` — Colour-aware "can I pay this right now" (pool + untapped lands) for the mana warning. (~21408 tok)
- `shared.ts` — Collects displayable keywords for a card from Scryfall keywords + scripted continuous effects. (~10649 tok)

## components/judge/


## components/layout/


## components/tutorial/


## components/ui/


## docs/


## docs/collection-optimizer/


## docs/commander-decks/


## lib/


## lib/collection/


## lib/collection/parsers/


## lib/collection/synergy/


## lib/game/

- `auto-tap.ts` — An untapped, single-colour, cost-free mana source the auto-tapper may use: (~1404 tok)
- `controller-selectors.ts` — Exports selectControllerViewModel, getCanQuickCast, canCardRespond, doesCardRequireStackTarget + 2 m (~1637 tok)

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

- `202605010388_adventure_spell_cast_face.sql` — Adventure spells trigger as their CAST FACE (bug-1513). (~7269 tok)

## supabase/migrations/ (200-215, 2026-06-10)


## tests/


## tests/feature/

- `adventure-spell-triggers.test.ts` — Adventure casts and spell-cast watchers (mig 388, bug-1513). A spell on the (~934 tok)

## tests/fixtures/


## tests/harness/


## tests/regression/


## tests/unit/

- `adventure-cast-gating.test.ts` — Adventure dual type_lines ("Creature — X // Instant — Adventure") must not (~940 tok)

## vercel/


## vercel/app/


## vercel/components/


## vercel/components/mtg/


## vercel/components/ui/


## vercel/hooks/


## vercel/lib/


## vercel/lib/mtg/


## vercel/styles/

