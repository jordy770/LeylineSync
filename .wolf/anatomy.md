# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-07-09T15:58:00.777Z
> Files: 54 tracked | Anatomy hits: 0 | Misses: 0

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

- `route.ts` — PATCH  /api/decks/:id  { name? , targetOverrides? } (~987 tok)

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

- `loading.tsx` — Instant skeleton while the dashboard aggregates the collection (value, (~140 tok)
- `page.tsx` — dynamic — renders form (~3330 tok)

## app/collection/advisor/

- `loading.tsx` — The Advisor diagnoses every deck server-side — the heaviest collection page, (~134 tok)
- `page.tsx` — dynamic (~3001 tok)

## app/collection/binders/

- `loading.tsx` — Works for both views: the shelf (spine-shaped bars) and an opened binder page. (~196 tok)
- `page.tsx` — dynamic (~2030 tok)

## app/collection/conflicts/


## app/collection/decks/[id]/

- `loading.tsx` — Loading (~65 tok)
- `page.tsx` — dynamic (~502 tok)

## app/collection/decks/import/


## app/collection/games/

- `loading.tsx` — Loading (~71 tok)
- `page.tsx` — dynamic (~655 tok)

## app/collection/import/


## app/collection/insights/


## app/collection/intelligence/


## app/collection/playground/


## app/collection/search/

- `loading.tsx` — Loading (~83 tok)

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

- `AdvisorContested.tsx` — AdvisorContested (~2457 tok)
- `AdvisorFits.tsx` — AdvisorFits (~1729 tok)
- `CardPocket.tsx` — MANA_GRADIENT (~552 tok)
- `CombosTab.tsx` — CombosTab (~1526 tok)
- `DeckDetail.tsx` — BUCKET_ORDER (~19935 tok)
- `GameAnalysisList.tsx` — GameAnalysisList (~1333 tok)
- `MulliganTab.tsx` — MulliganTab (~1636 tok)
- `SearchLive.tsx` — COLORS (~3669 tok)
- `Shell.tsx` — Which section to highlight in the sub-nav. Omit on nested pages (deck detail). (~1109 tok)
- `Skeletons.tsx` — Full-page shell for route-level loading.tsx files. (~1134 tok)
- `TradeBuilder.tsx` — TradeBuilder (~1509 tok)
- `ui.tsx` — Color-identity pips rendered as small mana-coloured dots. (~758 tok)

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
- `ai-recommend.ts` — Flatten the scan's free + occupied upgrades into one candidate list (deduped). (~4484 tok)
- `ai-trade.ts` — Pure: keep only offered cards that are really in the tradable list, and (~1229 tok)
- `analyze-deck.ts` — Deck analysis: load → score → (optionally) cache the result in co_deck_analyses. (~359 tok)
- `brackets.ts` — How many Game Changers a deck may hold at a target bracket. (~1148 tok)
- `buy-suggestions.ts` — A Scryfall exact-name search link — the brief uses Scryfall for card info/pricing. (~1448 tok)
- `deck-loader.ts` — Pet cards — never propose cutting these. (~2536 tok)
- `insights.ts` — Pure: rank the binder candidates that fit ONE deck (colour-legal, fills a need), (~1716 tok)
- `mulligan.ts` — Pure sample-hand drawing for the mulligan trainer. The caller supplies the (~203 tok)
- `power-score.ts` — Tags a player may set a per-deck target for. counterspell/tutor have no (~3113 tok)
- `upgrade-scanner.ts` — colorIdentity ⊆ deckIdentity (~4482 tok)

## lib/collection/parsers/


## lib/collection/synergy/


## lib/game/


## lib/intelligence/


## lib/intelligence/rules/


## lib/supabase/


## mockups/

- `collection-binder-screens.html` — LeylineSync · Binder-concept — alle schermen (~6724 tok)
- `collection-concepts.html` — LeylineSync · Collection — stijlconcepten (~7060 tok)

## public/


## scripts/


## supabase/


## supabase/functions/spawn-deck/


## supabase/functions_src/


## supabase/migrations/

- `202605010382_premium_ai_credits.sql` — Premium entitlements + AI usage quota (Collection Optimizer monetization). (~893 tok)
- `202605010383_player_meta.sql` — Playgroup meta profile (AI personalization). (~204 tok)
- `202605010384_deck_target_overrides.sql` — Per-deck target tuning. (~187 tok)
- `202605010385_card_locks.sql` — Card locks per deck. (~124 tok)

## supabase/migrations/ (200-215, 2026-06-10)


## tests/


## tests/feature/

- `ai-quota.test.ts` — Premium AI credits (mig 382). consume_ai_credit is the single server-side (~1236 tok)

## tests/fixtures/


## tests/harness/


## tests/regression/


## tests/unit/

- `ai-recommend.test.ts` — AI deck-doctor — the pure grounding helpers. The model call itself is not tested (~1186 tok)
- `ai-suite.test.ts` — Pure cores of the premium AI suite: sample-hand drawing (mulligan trainer), (~829 tok)
- `target-overrides.test.ts` — Per-deck target tuning (mig 384) — the pure engine side: overrides shift the (~741 tok)

## vercel/


## vercel/app/


## vercel/components/


## vercel/components/mtg/


## vercel/components/ui/


## vercel/hooks/


## vercel/lib/


## vercel/lib/mtg/


## vercel/styles/

