# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-07-15T11:08:14.300Z
> Files: 18 tracked | Anatomy hits: 0 | Misses: 0

## ../../.claude/jobs/adcb6c2b/tmp/


## ../../.claude/jobs/ca267fb9/tmp/


## ../../.claude/jobs/ca267fb9/tmp/fixdrafts/


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


## components/board/


## components/collection/


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


## lib/collection/parsers/


## lib/collection/synergy/


## lib/game/

- `card-behavior-schema.ts` — ─── Shared primitives ─────────────────────────────────────────────────────── (~23213 tok)
- `types.ts` — Short room code for the /tv spectator flow (mig 379). (~3095 tok)

## lib/intelligence/


## lib/intelligence/rules/


## lib/supabase/


## mockups/


## public/


## scripts/


## supabase/


## supabase/functions/spawn-deck/


## supabase/functions_src/

- `activate_ability.sql` — supabase/functions_src/activate_ability.sql (~9712 tok)
- `advance_step.sql` — supabase/functions_src/advance_step.sql (~4215 tok)
- `apply_creature_effect.sql` — supabase/functions_src/apply_creature_effect.sql (~7485 tok)
- `apply_trigger_effects.sql` — supabase/functions_src/apply_trigger_effects.sql (~24163 tok)
- `apply_triggered_ability_effects.sql` — supabase/functions_src/apply_triggered_ability_effects.sql (~14411 tok)
- `choose_triggered_ability_targets.sql` — supabase/functions_src/choose_triggered_ability_targets.sql (~893 tok)
- `cycle_card.sql` — supabase/functions_src/cycle_card.sql (~911 tok)
- `fire_watcher_triggers.sql` — supabase/functions_src/fire_watcher_triggers.sql (~4347 tok)
- `fire_zone_change_triggers.sql` — supabase/functions_src/fire_zone_change_triggers.sql (~1832 tok)
- `note_card_drawn.sql` — supabase/functions_src/note_card_drawn.sql (~349 tok)
- `submit_decision.sql` — Declares public (~16554 tok)

## supabase/migrations/


## supabase/migrations/ (200-215, 2026-06-10)


## tests/


## tests/feature/

- `card-drawn-watcher.test.ts` — mig 401 — card_drawn watcher: every real draw (draw effect, natural draw, (~1076 tok)
- `exile-until-leaves-return-to.test.ts` — mig 404 — exile_until_leaves gains multi-target ("up to three") + a (~784 tok)
- `graveyard-exile-until-leaves.test.ts` — mig 405 — graveyard-target triggers (exile_graveyard_until_leaves), the (~1057 tok)
- `sacrifice-filters-and-stun.test.ts` — mig 402 — subtype/another filters on sacrifice costs (Professional (~1215 tok)

## tests/fixtures/


## tests/harness/


## tests/regression/


## tests/unit/

- `registry-schema-drift.test.ts` — Drift guard for the card-behavior authoring stack's two type vocabularies: (~3356 tok)

## vercel/


## vercel/app/


## vercel/components/


## vercel/components/mtg/


## vercel/components/ui/


## vercel/hooks/


## vercel/lib/


## vercel/lib/mtg/


## vercel/styles/

