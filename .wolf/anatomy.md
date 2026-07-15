# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-07-14T22:06:05.804Z
> Files: 70 tracked | Anatomy hits: 0 | Misses: 0

## ../../.claude/jobs/adcb6c2b/tmp/


## ../../.claude/jobs/ca267fb9/tmp/

- `card-script-audit-finish.js` — Exports meta (~2390 tok)
- `fix-agent-prompt.txt` — Declares enums (~981 tok)
- `validate-fixes.mjs` — Validate drafted fix scripts: validateCardScript + Zod deep-diff (silently-stripped (~642 tok)

## ../../.claude/jobs/ca267fb9/tmp/fixdrafts/

- `batch-01.json` — Declares line (~2656 tok)
- `batch-02.json` — grant: nothing (~2298 tok)
- `batch-03.json` — filter: trigger (~2257 tok)
- `batch-04.json` — Declares you (~2231 tok)
- `batch-05.json` — Declares mode (~2271 tok)
- `batch-06.json` — among: creature (~2004 tok)
- `batch-07.json` — Declares wipe (~2718 tok)
- `batch-08.json` — Declares filter (~2088 tok)
- `batch-09.json` — Declares nonland_permanent (~2030 tok)

## ../../.claude/plans/


## ../../.claude/projects/C--Users-Jordy-dev-LeylineSync/5705253f-fa3a-4781-b264-b9ec72069b46/workflows/scripts/


## ../../.claude/projects/C--Users-Jordy-dev-LeylineSync/cbab7504-eb67-46c3-a9ec-5892512d9617/workflows/scripts/

- `card-script-oracle-audit-wf_78bf6d09-6bf.js` — Exports meta (~1917 tok)

## ../../.claude/projects/C--Users-Jordy-dev-LeylineSync/memory/


## ../../.cloudflared/


## ../../AppData/Local/Temp/claude/C--Users-Jordy-dev-LeylineSync/29ade7df-e915-4e92-91d0-74481e09da2e/scratchpad/


## ../../AppData/Local/Temp/claude/C--Users-Jordy-dev-LeylineSync/5705253f-fa3a-4781-b264-b9ec72069b46/scratchpad/


## ../../AppData/Local/Temp/claude/C--Users-Jordy-dev-LeylineSync/6cbaf238-ecfd-454f-9738-19dff50029e0/scratchpad/


## ../../AppData/Local/Temp/claude/C--Users-Jordy-dev-LeylineSync/a403f535-8b14-4f77-9426-b571a70d18cf/scratchpad/


## ../../AppData/Local/Temp/claude/C--Users-Jordy-dev-LeylineSync/b3467b9f-c3ab-4823-9620-fb93c878b451/scratchpad/


## ../../AppData/Local/Temp/claude/C--Users-Jordy-dev-LeylineSync/cbab7504-eb67-46c3-a9ec-5892512d9617/scratchpad/

- `prep-audit-chunks.mjs` — Build per-chunk audit inputs: {name, type_line, oracle_text, script} x20 per file. (~508 tok)

## ../../AppData/Local/Temp/claude/C--Users-Jordy-dev-LeylineSync/cbab7504-eb67-46c3-a9ec-5892512d9617/scratchpad/audit-chunks/

- `engine-vocab.md` — LeylineSync Engine Vocabulary — audit cheat sheet (schema_version 2) (~4121 tok)

## ../../AppData/Local/Temp/claude/C--Users-Jordy-dev-LeylineSync/e378a9bd-21e1-45b0-8890-278da934081a/scratchpad/

- `validate-diff.mjs` — Validate each pipeline script AND deep-diff it against the Zod parse output (~452 tok)

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

- `ControllerListV5.tsx` — The mana an untapped card auto-produces when it has exactly one simple (~72451 tok)
- `GameBoard.tsx` — GameBoard (~10221 tok)

## components/board/


## components/collection/


## components/controller/

- `CardActionSheet.tsx` — Current turn number — gates a GRANTED flashback (Snapcaster, mig 392). (~21558 tok)
- `shared.ts` — Whether one of YOUR battlefield permanents grants this hand card flash via a (~11192 tok)

## components/judge/


## components/layout/


## components/tutorial/


## components/ui/


## docs/


## docs/collection-optimizer/


## docs/commander-decks/

- **card-script-audit-2026-07-14.json** — volledige oracle-audit (956 kaarten, verdict/issues/severity). ~200k tokens — NOOIT integraal lezen; jq/grep per kaartnaam.
- **card-script-audit-2026-07-14.md** — leesbaar auditrapport (463 accurate / 473 partial / 7 wrong / 9 inert / 4 uncertain). ~8k tokens.
- **card-script-fixes-2026-07-14.md** — fix-rapport + engine-batch 1 (mig 394-397) + batch 2 (mig 398-400): 45+13 scripts gewijzigd, engine-shortlist, schema-achterstand-bevinding. ~8k tokens.

## lib/


## lib/collection/


## lib/collection/parsers/


## lib/collection/synergy/


## lib/game/

- `auto-tap.ts` — An untapped, single-colour, cost-free mana source the auto-tapper may use: (~1404 tok)
- `card-behavior-schema.ts` — ─── Shared primitives ─────────────────────────────────────────────────────── (~22561 tok)
- `controller-selectors.ts` — Exports selectControllerViewModel, cardHasFlashKeyword, getCanQuickCast, canCardRespond + 3 more (~1876 tok)

## lib/intelligence/


## lib/intelligence/rules/


## lib/supabase/


## mockups/


## public/


## scripts/

- `triage-decklist.mjs` — Decklist triage — the planning step before implementing a deck's cards. (~3882 tok)

## supabase/


## supabase/functions/spawn-deck/


## supabase/functions_src/

- `apply_creature_effect.sql` — supabase/functions_src/apply_creature_effect.sql (~7271 tok)
- `apply_mass_pump_until_eot.sql` — supabase/functions_src/apply_mass_pump_until_eot.sql (~938 tok)
- `apply_trigger_effects.sql` — supabase/functions_src/apply_trigger_effects.sql (~23598 tok)
- `apply_triggered_ability_effects.sql` — supabase/functions_src/apply_triggered_ability_effects.sql (~14321 tok)
- `card_cda_value.sql` — supabase/functions_src/card_cda_value.sql (~919 tok)
- `card_has_flash.sql` — supabase/functions_src/card_has_flash.sql (~609 tok)
- `card_has_unblockable.sql` — supabase/functions_src/card_has_unblockable.sql (~509 tok)
- `cast_card_from_hand.sql` — supabase/functions_src/cast_card_from_hand.sql (~6246 tok)
- `cast_spell_effect.sql` — supabase/functions_src/cast_spell_effect.sql (~3570 tok)
- `declare_blocker.sql` — supabase/functions_src/declare_blocker.sql (~1986 tok)
- `effective_script.sql` — supabase/functions_src/effective_script.sql (~733 tok)
- `fire_token_created.sql` — supabase/functions_src/fire_token_created.sql (~435 tok)
- `fire_turn_step_triggers.sql` — supabase/functions_src/fire_turn_step_triggers.sql (~765 tok)
- `fire_watcher_triggers.sql` — supabase/functions_src/fire_watcher_triggers.sql (~4060 tok)
- `handle_counter_spell.sql` — supabase/functions_src/handle_counter_spell.sql (~1819 tok)
- `reduced_mana_cost.sql` — supabase/functions_src/reduced_mana_cost.sql (~1296 tok)
- `register_card_continuous_effects.sql` — supabase/functions_src/register_card_continuous_effects.sql (~3002 tok)
- `resolve_count_amount.sql` — supabase/functions_src/resolve_count_amount.sql (~4346 tok)
- `submit_decision.sql` — Declares public (~16050 tok)

## supabase/migrations/

- `202605010388_adventure_spell_cast_face.sql` — Adventure spells trigger as their CAST FACE (bug-1513). (~7269 tok)
- `202605010389_wight_opponents_graveyard_cda.sql` — Wight of Precinct Six (Wilhelt precon) — new CDA count (mig 149 layer 7a): (~967 tok)
- `202605010390_dockside_chain_reaction_counts.sql` — 202605010390_dockside_chain_reaction_counts (~4314 tok)
- `202605010393_effective_script_scalar_guard.sql` — effective_script: guard tegen jsonb-scalar catalogscripts bij granted_ability merge (bug-2687, Hero token). (~700 tok)
- `202605010394_draw_recipient.sql` — draw honoreert recipient: controller/each_player/each_opponent/active_player (bug-2684, Cut a Deal). (~14000 tok)
- `202605010395_mass_effect_opponent_scope.sql` — pump_all scope 'opponent' (rij per opponent), deal_damage_all filter.controller+tap_damaged, destroy_all types-branch scope (Phyresis/Thundermaw/Ruinous). (~15000 tok)
- `202605010396_broadcast_turn_step_events.sql` — broadcast beginning_of_each_upkeep/each_draw_step (patroon mig 206) + draw active_player (Midnight Clock, Ophiomancer, Kami). (~15000 tok)
- `202605010397_unblockable_grant.sql` — grant_keyword 'unblockable' + card_has_unblockable + declare_blocker-guard + CHECK rebuild (Rogue's Passage, Hraesvelgr). (~9000 tok)
- `202605010398_flash_timing.sql` — card_has_flash + sorcery-gate bypass in cast_card_from_hand + flash_permission continuous effect + CHECK rebuild (Shimmer Myr, Snapcaster-klasse). (~12000 tok)
- `202605010399_token_created_watcher.sql` — fire_token_created (AFTER INSERT game_cards) + turn_tokens_created tally + token_created default-typefilter in fire_watcher_triggers (Mirkwood Bats, Idol of Oblivion; bevat mig 388-backfill, bug-2689). (~16000 tok)
- `202605010400_search_max_mana_value.sql` — search_library filter.max_mana_value (Trinket Mage). (~14000 tok)

## supabase/migrations/ (200-215, 2026-06-10)


## tests/


## tests/feature/

- `adventure-spell-triggers.test.ts` — Adventure casts and spell-cast watchers (mig 388, bug-1513). A spell on the (~934 tok)
- `broadcast-turn-step-events.test.ts` — mig 396 — broadcast turn-step events: beginning_of_each_upkeep and (~1033 tok)
- `color-cost-reduction.test.ts` — mig 391 — color-filtered static cost_reduction (Sapphire Medallion, Talrand (~701 tok)
- `debug-dockside.test.ts` — TEMP debug for DC1 — delete after diagnosis. (~483 tok)
- `deck-smoke.test.ts` — Deck smoke test: every curated script in docs/commander-decks/card-scripts.json (~2936 tok)
- `dockside-chain-reaction-counts.test.ts` — mig 390 — two new resolve_count_amount counts (Prosper precon): (~959 tok)
- `draw-recipient.test.ts` — mig 394 — draw honors `recipient` (bug-2684): each_opponent / each_player (~868 tok)
- `eldrazi-spawn-tokens.test.ts` — Eldrazi Scion/Spawn tokens (Sifter of Skulls / Pawn of Ulamog, Meren precon): (~335 tok)
- `flash-timing.test.ts` — mig 398 — flash in the cast timing gate: a nonland hand card with keyword (~727 tok)
- `mass-effect-opponent-scope.test.ts` — mig 395 — opponent scope on mass effects: (~1539 tok)
- `search-max-mana-value.test.ts` — mig 400 — search_library filter.max_mana_value (Trinket Mage: "an artifact (~407 tok)
- `shivan-devastator-x.test.ts` — Shivan Devastator (Prosper precon) — "enters with X +1/+1 counters": (~618 tok)
- `talrand-finishers.test.ts` — mig 392 — the four engine features that finish the Talrand precon and remove (~2757 tok)
- `token-created-watcher.test.ts` — mig 399 — token_created watcher event + tokens_created_this_turn count: (~878 tok)
- `unblockable-grant.test.ts` — mig 397 — grant_keyword 'unblockable' ("can't be blocked this turn"): (~446 tok)
- `wight-opponents-graveyard-cda.test.ts` — mig 389 — CDA count 'creature_cards_in_opponents_graveyards' (Wight of (~428 tok)

## tests/fixtures/

- `test-cards.json` (~50108 tok)

## tests/harness/


## tests/regression/


## tests/unit/

- `adventure-cast-gating.test.ts` — Adventure dual type_lines ("Creature — X // Instant — Adventure") must not (~940 tok)
- `registry-schema-drift.test.ts` — Drift guard for the card-behavior authoring stack's two type vocabularies: (~3296 tok)

## vercel/


## vercel/app/


## vercel/components/


## vercel/components/mtg/


## vercel/components/ui/


## vercel/hooks/


## vercel/lib/


## vercel/lib/mtg/


## vercel/styles/

