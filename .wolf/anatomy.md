# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-07-09T14:11:43.957Z
> Files: 26 tracked | Anatomy hits: 0 | Misses: 0

## ../../.claude/jobs/adcb6c2b/tmp/


## ../../.claude/plans/


## ../../.claude/projects/C--Users-Jordy-dev-LeylineSync/5705253f-fa3a-4781-b264-b9ec72069b46/workflows/scripts/


## ../../.claude/projects/C--Users-Jordy-dev-LeylineSync/memory/


## ../../.cloudflared/


## ../../AppData/Local/Temp/claude/C--Users-Jordy-dev-LeylineSync/29ade7df-e915-4e92-91d0-74481e09da2e/scratchpad/


## ../../AppData/Local/Temp/claude/C--Users-Jordy-dev-LeylineSync/5705253f-fa3a-4781-b264-b9ec72069b46/scratchpad/


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


## app/api/collection/import/


## app/api/collection/move-card/


## app/api/collection/resolve-conflict/


## app/api/collection/search/


## app/api/conflicts/


## app/api/decks/[id]/


## app/api/decks/[id]/analysis/


## app/api/decks/[id]/buy/


## app/api/decks/[id]/combos/

- `route.ts` — POST /api/decks/:id/combos — premium: which combo lines does this deck (and (~441 tok)

## app/api/decks/[id]/commander/


## app/api/decks/[id]/mulligan/

- `route.ts` — POST /api/decks/:id/mulligan  { hand: string[], choice: 'keep'|'mulligan' } (~562 tok)

## app/api/decks/[id]/play/


## app/api/decks/[id]/pull-list/


## app/api/decks/[id]/recommend/

- `route.ts` — POST /api/decks/:id/recommend (~665 tok)

## app/api/decks/[id]/swaps/


## app/api/decks/[id]/sync/


## app/api/decks/[id]/upgrades/


## app/api/decks/import/


## app/api/games/[id]/analyze/

- `route.ts` — POST /api/games/:id/analyze — premium post-game coaching from the engine's (~444 tok)

## app/api/intelligence/classify/


## app/api/trade/

- `route.ts` — POST /api/trade  { want: string, targetValueEur?: number } (~546 tok)

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

- `page.tsx` — dynamic (~3001 tok)

## app/collection/binders/


## app/collection/conflicts/


## app/collection/decks/[id]/


## app/collection/decks/import/


## app/collection/games/

- `page.tsx` — dynamic (~655 tok)

## app/collection/import/


## app/collection/insights/


## app/collection/intelligence/


## app/collection/playground/


## app/collection/search/


## app/controller-style-lab/


## app/controller/[id]/


## app/decks/


## app/judge/[id]/


## app/manifest.webmanifest/


## app/protected/


## app/style-guide/


## app/tv/


## components/


## components/board/


## components/collection/

- `CombosTab.tsx` — CombosTab (~1524 tok)
- `DeckDetail.tsx` — BUCKET_ORDER (~16822 tok)
- `GameAnalysisList.tsx` — GameAnalysisList (~1327 tok)
- `MulliganTab.tsx` — MulliganTab (~1678 tok)
- `TradeBuilder.tsx` — TradeBuilder (~1507 tok)

## components/controller/


## components/judge/


## components/layout/


## components/tutorial/


## components/ui/


## docs/


## docs/collection-optimizer/


## docs/commander-decks/


## lib/


## lib/collection/

- `ai-client.ts` — One JSON-shaped exchange: cached static system prompt, JSON context in the (~673 tok)
- `ai-combos.ts` — A card completing the line that the player does NOT own (buy target). (~1595 tok)
- `ai-game-analysis.ts` — Post-game analysis — the feature only LeylineSync can build: the app IS the (~1059 tok)
- `ai-gate.ts` — The one paywall/quota gate every premium AI route calls before touching the (~350 tok)
- `ai-mulligan.ts` — Mulligan trainer — the player judges a sample hand from their own deck, the (~944 tok)
- `ai-recommend.ts` — Flatten the scan's free + occupied upgrades into one candidate list (deduped). (~4072 tok)
- `ai-trade.ts` — Pure: keep only offered cards that are really in the tradable list, and (~1229 tok)
- `mulligan.ts` — Pure sample-hand drawing for the mulligan trainer. The caller supplies the (~203 tok)

## lib/collection/parsers/


## lib/collection/synergy/


## lib/game/


## lib/intelligence/


## lib/intelligence/rules/


## lib/supabase/


## mockups/

- `collection-concepts.html` — LeylineSync · Collection — stijlconcepten (~7060 tok)

## public/


## scripts/


## supabase/


## supabase/functions/spawn-deck/


## supabase/functions_src/


## supabase/migrations/

- `202605010382_premium_ai_credits.sql` — Premium entitlements + AI usage quota (Collection Optimizer monetization). (~893 tok)
- `202605010383_player_meta.sql` — Playgroup meta profile (AI personalization). (~204 tok)

## supabase/migrations/ (200-215, 2026-06-10)


## tests/


## tests/feature/

- `ai-quota.test.ts` — Premium AI credits (mig 382). consume_ai_credit is the single server-side (~1236 tok)

## tests/fixtures/


## tests/harness/


## tests/regression/


## tests/unit/

- `ai-recommend.test.ts` — AI deck-doctor — the pure grounding helpers. The model call itself is not tested (~830 tok)
- `ai-suite.test.ts` — Pure cores of the premium AI suite: sample-hand drawing (mulligan trainer), (~829 tok)

## vercel/


## vercel/app/


## vercel/components/


## vercel/components/mtg/


## vercel/components/ui/


## vercel/hooks/


## vercel/lib/


## vercel/lib/mtg/


## vercel/styles/

