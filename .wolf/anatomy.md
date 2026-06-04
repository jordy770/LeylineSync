# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-06-04T14:17:22.158Z
> Files: 356 tracked | Anatomy hits: 0 | Misses: 0

## ./

- `.gitignore` — Git ignore rules (~167 tok)
- `CLAUDE.md` — OpenWolf (~57 tok)
- `components.json` (~128 tok)
- `eslint.config.mjs` — ESLint flat configuration (~135 tok)
- `next.config.ts` — Next.js configuration (~99 tok)
- `package-lock.json` — npm lock file (~75642 tok)
- `package.json` — Node.js package manifest (~534 tok)
- `postcss.config.mjs` — Declares config (~45 tok)
- `proxy.ts` — Exports proxy, config (~184 tok)
- `README.md` — Project documentation (~15476 tok)
- `tailwind.config.ts` — Tailwind CSS configuration (~558 tok)
- `tsconfig.json` — TypeScript configuration (~218 tok)

## .claude/

- `settings.json` (~441 tok)

## .claude/projects/c--Users-Jordy-dev-LeylineSync/memory/

- `feedback_workflow.md` (~281 tok)
- `MEMORY.md` — Memory Index (~235 tok)
- `project_architecture.md` (~472 tok)
- `project_hard_rules.md` — Declares in (~392 tok)
- `project_overview.md` — Declares in (~290 tok)
- `project_roadmap.md` — LeylineSync — Combined Roadmap (as of 2026-06-04) (~1462 tok)
- `project_styling.md` (~401 tok)
- `reference_pencil_designs.md` (~283 tok)

## .claude/rules/

- `openwolf.md` (~313 tok)

## .git/

- `COMMITMSG.tmp` (~108 tok)

## Phase 1 Tier-B scry (added 2026-06-02)


## app/

- `globals.css` — Styles: 6 rules, 49 vars, 2 media queries, 2 animations, 3 layers (~1108 tok)
- `layout.tsx` — defaultUrl (~308 tok)
- `page.tsx` — Home (~738 tok)

## app/api/cards/generate-behavior/

- `route.ts` — POST /api/cards/generate-behavior (~1333 tok)

## app/auth/confirm/

- `route.ts` — Next.js API route: GET (~296 tok)

## app/auth/error/

- `page.tsx` — ErrorContent (~370 tok)

## app/auth/forgot-password/

- `page.tsx` — Page (~90 tok)

## app/auth/login/

- `page.tsx` — getSafeRedirect (~338 tok)

## app/auth/sign-up-success/

- `page.tsx` — Page (~271 tok)

## app/auth/sign-up/

- `page.tsx` — Page (~83 tok)

## app/auth/update-password/

- `page.tsx` — Page (~90 tok)

## app/board/[id]/

- `page.tsx` — BoardPage (~215 tok)

## app/cards/behavior/

- `page.tsx` — CardBehaviorPage (~346 tok)

## app/controller-style-lab/

- `controller-style-lab.module.css` — Styles: 114 rules, 1 vars, 2 media queries (~3062 tok)
- `page.tsx` — handCards — uses useRef (~3360 tok)

## app/controller/[id]/

- `page.tsx` — ControllerPage (~396 tok)

## app/decks/

- `page.tsx` — DecksPage (~735 tok)

## app/judge/[id]/

- `page.tsx` — JudgePage (~221 tok)

## app/protected/

- `layout.tsx` — ProtectedLayout (~554 tok)
- `page.tsx` — UserDetails (~400 tok)

## components/

- `ActionButtons.tsx` — ActionButtons (~4382 tok)
- `auth-button.tsx` — AuthButton (~239 tok)
- `CardBehaviorEditor.tsx` — EMPTY_SCRIPT_PLACEHOLDER (~3958 tok)
- `CardBehaviorForm.tsx` — inputClass (~5621 tok)
- `CardCatalogPicker.tsx` — cardTypeFilters — uses useMemo, useState, useEffect (~2316 tok)
- `CardController.tsx` — CardController — uses useMemo (~221 tok)
- `CardZoneControls.tsx` — CardZoneControls — uses useMemo, useState (~2178 tok)
- `CombatAssignmentsPanel.tsx` — CombatAssignmentsPanel — uses useMemo, useState, useEffect (~3664 tok)
- `CombatManager.tsx` — CombatManager — uses useRef, useMemo, useEffect (~2880 tok)
- `ControllerList.tsx` — components/ControllerList.tsx (~20457 tok)
- `ControllerListV2.tsx` — ControllerListV2 — uses useState, useMemo (~10088 tok)
- `ControllerListV3.tsx` — manaColors — uses useMemo (~6422 tok)
- `ControllerListV4.tsx` — Returns the single mana color to auto-produce when a card has exactly one simple tap ability. (~39473 tok)
- `DeckManager.tsx` — DeckManager — uses useMemo, useState, useEffect (~3880 tok)
- `deploy-button.tsx` — DeployButton (~385 tok)
- `DevAdminPanel.tsx` — DevAdminPanel (~3316 tok)
- `DrawCardButton.tsx` — DrawCardButton — uses useMemo, useState (~906 tok)
- `env-var-warning.tsx` — EnvVarWarning (~160 tok)
- `forgot-password-form.tsx` — ForgotPasswordForm — renders form — uses useState (~1049 tok)
- `GameBoard.tsx` — GameBoard — renders map — uses useMemo, useCallback (~5225 tok)
- `GameSessionLobby.tsx` — GameSessionLobby — uses useMemo, useState, useEffect (~4238 tok)
- `GameStatusPanel.tsx` — GameStatusPanel — uses useMemo, useEffect (~981 tok)
- `hero.tsx` — Hero (~428 tok)
- `JudgePanel.tsx` — JudgePanel (~1502 tok)
- `LifeTotalsPanel.tsx` — LifeTotalsPanel — uses useMemo, useState, useEffect (~1855 tok)
- `login-form.tsx` — LoginForm — renders form — uses useState, useRouter (~1029 tok)
- `logout-button.tsx` — LogoutButton — uses useRouter (~126 tok)
- `ManaPool.tsx` — manaColors — uses useMemo, useState, useEffect (~1433 tok)
- `MotionCard.tsx` — MotionCard (~1112 tok)
- `next-logo.tsx` — NextLogo (~1154 tok)
- `PlayerActionPanel.tsx` — PlayerActionPanel — uses useMemo, useState (~1218 tok)
- `sign-up-form.tsx` — SignUpForm — renders form — uses useState, useRouter (~1128 tok)
- `StackPanel.tsx` — StackPanel — uses useMemo, useEffect (~1239 tok)
- `StaticEffectControls.tsx` — copyPresets — uses useMemo, useState (~1592 tok)
- `supabase-logo.tsx` — SupabaseLogo (~2094 tok)
- `theme-switcher.tsx` — ThemeSwitcher — uses useState, useEffect (~676 tok)
- `TurnStatusPanel.tsx` — phaseLabels — uses useMemo, useState, useEffect (~2658 tok)
- `update-password-form.tsx` — UpdatePasswordForm — renders form — uses useState, useRouter (~734 tok)

## components/board/

- `BoardConnectionOverlay.tsx` — BoardConnectionOverlay (~481 tok)
- `BoardViewChrome.tsx` — BoardViewChrome (~420 tok)
- `EmptyBoardPanel.tsx` — EmptyBoardPanel (~95 tok)
- `StackRail.tsx` — StackRail (~577 tok)

## components/controller/

- `ControllerAtoms.tsx` — manaColors (~832 tok)

## components/judge/

- `JudgePlayerCardTools.tsx` — JudgePlayerCardTools (~2837 tok)
- `JudgeStatChip.tsx` — JudgeStatChip (~219 tok)
- `PlayerManaPool.tsx` — manaColorsForDisplay (~519 tok)
- `RecentJudgeActions.tsx` — RecentJudgeActions (~833 tok)

## components/layout/

- `ControllerViewNav.tsx` — ControllerViewNav (~390 tok)
- `GameViewHeader.tsx` — GameViewHeader (~695 tok)

## components/tutorial/

- `code-block.tsx` — CopyIcon — uses useState (~408 tok)
- `connect-supabase-steps.tsx` — ConnectSupabaseSteps (~626 tok)
- `fetch-data-steps.tsx` — create — uses useEffect (~1475 tok)
- `sign-up-user-steps.tsx` — </span> (~1057 tok)
- `tutorial-step.tsx` — TutorialStep (~204 tok)

## components/ui/

- `badge.tsx` — badgeVariants (~338 tok)
- `button.tsx` — buttonVariants (~564 tok)
- `card.tsx` — Card (~555 tok)
- `checkbox.tsx` — Checkbox (~305 tok)
- `dropdown-menu.tsx` — DropdownMenu (~2243 tok)
- `input.tsx` — Input (~228 tok)
- `label.tsx` — labelVariants (~218 tok)

## docs/

- `design-conversation-summary.md` — LeylineSync Design Conversation Summary (~2946 tok)
- `test-plan-079-086.md` — Test plan — migrations 079–086 (~2178 tok)

## lib/

- `utils.ts` — Exports cn, hasEnvVars (~104 tok)

## lib/game/

- `action-selectors.ts` — Exports CardWithScript, getActionTiming, isPlayerDamageAction, isRetainManaAction + 3 more (~652 tok)
- `actions.ts` — Exports getErrorMessage, setCardTapped, moveCardToZone, castCardFromHand + 25 more (~7788 tok)
- `blueprint.ts` — Exports GameViewStep, BoardLayoutKey, PriorityRole, StackActionType + 21 more (~3457 tok)
- `board-selectors.ts` — Exports BoardSeat, BoardConnection, buildBoardSeats, getCombatCardIds + 2 more (~812 tok)
- `card-behavior-builder.ts` — Guided card-behavior form model: a structured representation of the subset of (~4909 tok)
- `card-behavior-llm.ts` — LLM-facing description of the card behavior script format. (~3540 tok)
- `card-behavior-registry.ts` — Declarative registry of the form-editable card effects. ONE entry per effect (~5053 tok)
- `card-behavior-schema.ts` — ─── Shared primitives ─────────────────────────────────────────────────────── (~3322 tok)
- `card-behavior.ts` — Exports CardBehaviorSchemaVersion, CardBehaviorStatus, CardBehaviorZone, CardBehaviorTargetType + 14 (~2557 tok)
- `controller-selectors.ts` — Exports selectControllerViewModel, getCanQuickCast, canCardRespond, doesCardRequireStackTarget + 2 more (~1459 tok)
- `data.ts` — Sums active until-end-of-turn pump effects per affected card id. Best-effort: returns {} on error. (~5490 tok)
- `dev.ts` — Exports showDevControls, enableFallbackRefresh, fallbackRefreshIntervalMs (~86 tok)
- `judge-selectors.ts` — Exports PlayerJudgeStats, buildPlayerJudgeStats, getEmptyPlayerJudgeStats (~235 tok)
- `legacy-controller-selectors.ts` — Exports LegacyControllerViewFocus, orderCardsByIds, selectLegacyControllerViewModel (~1119 tok)
- `mana.ts` — Exports manaColors, ManaPayment, ParsedManaCost, parseManaCost + 4 more (~600 tok)
- `types.ts` — Exports ManaPool, ManaColor, GameZone, GameSessionStatus + 29 more (~2317 tok)
- `use-board-game-state.ts` — Exports useBoardGameState (~1008 tok)
- `use-card-action-handlers.ts` — Exports useCardActionHandlers (~1286 tok)
- `use-controller-game-state.ts` — Exports useControllerGameState (~1976 tok)
- `use-game-loop-state.ts` — Exports UseGameLoopStateResult, useGameLoopState, fetchGameLoopState (~1580 tok)
- `use-judge-action-log.ts` — Exports useJudgeActionLog (~281 tok)
- `use-judge-card-tools.ts` — Exports useJudgeCardTools (~1465 tok)
- `use-judge-game-state.ts` — Exports useJudgeGameState (~1130 tok)
- `use-legacy-controller-game-state.ts` — Exports useLegacyControllerGameState (~2299 tok)

## lib/supabase/

- `client.ts` — Exports createClient (~66 tok)
- `proxy.ts` — Exports updateSession (~814 tok)
- `server.ts` — Especially important if using Fluid compute: Don't put this client in a (~287 tok)

## public/

- `controller-wireframes.html` — Lely Horizon - UX Iteratie Opties (~6191 tok)

## scripts/

- `import-scryfall-cards.mjs` — defaultInputFile: flushBatch, upsertBatchWithRetry, getSupabaseErrorMessage + 15 more (~3063 tok)
- `setup-local-test-db.mjs` — Rebuilds the LOCAL test-harness database from scratch. (~721 tok)
- `test-board-setup.sql` — Test board setup for the new mechanics (deathtouch, +1/+1 counters, pumps, (~1705 tok)
- `validate-card-scripts.ts` — Audit script — validates all card scripts in the database against the Zod schema. (~559 tok)

## supabase/

- `config.toml` (~141 tok)

## supabase/functions/spawn-deck/

- `.npmrc` — Configuration for private npm package dependencies (~60 tok)
- `deno.json` — Deno configuration (~26 tok)
- `index.ts` — API routes: GET (3 endpoints) (~1329 tok)

## supabase/migrations/

- `00000000000000_baseline.sql` — Baseline bootstrap for local / from-scratch builds. (~1071 tok)
- `00000000000001_local_test_relax_fks.sql` — LOCAL TEST DB ONLY (sorts right after the baseline). Do NOT apply to hosted. (~285 tok)
- `202605010000_move_card_to_zone.sql` — SQL: 2 alter(s), 1 function(s) (~299 tok)
- `202605010001_add_mana_from_card.sql` — SQL: 1 function(s) (~713 tok)
- `202605010002_draw_card.sql` — SQL: 1 alter(s), 1 function(s) (~483 tok)
- `202605010003_untap_all.sql` — SQL: 1 function(s) (~193 tok)
- `202605010004_clear_mana_pool.sql` — SQL: 1 function(s) (~209 tok)
- `202605010005_turn_state.sql` — SQL: tables: public, 2 function(s) (~619 tok)
- `202605010006_advance_step.sql` — SQL: 1 function(s) (~710 tok)
- `202605010007_advance_step_untap.sql` — SQL: 1 function(s) (~774 tok)
- `202605010008_advance_step_draw.sql` — SQL: 1 function(s) (~1022 tok)
- `202605010009_game_sessions.sql` — SQL: tables: public, public, 14 alter(s), 3 function(s) (~1584 tok)
- `202605010010_session_membership_hardening.sql` — SQL: 2 function(s) (~1210 tok)
- `202605010011_finish_game_session.sql` — SQL: 1 function(s) (~202 tok)
- `202605010012_session_read_policies.sql` — SQL: 2 alter(s), 1 function(s) (~470 tok)
- `202605010012_zzzz_replayfix_get_session_players.sql` — Replay fix for clean/from-scratch builds (sorts between 012 and 013). (~172 tok)
- `202605010013_session_player_usernames.sql` — SQL: 1 function(s) (~281 tok)
- `202605010014_turn_rotation.sql` — SQL: 1 function(s) (~1479 tok)
- `202605010015_turn_state_realtime.sql` (~86 tok)
- `202605010016_adjust_player_life.sql` — SQL: 1 function(s) (~529 tok)
- `202605010017_combat_declarations.sql` — SQL: tables: public, 1 alter(s), 4 function(s) (~3502 tok)
- `202605010018_combat_action_state.sql` — SQL: 1 function(s) (~480 tok)
- `202605010019_combat_blockers.sql` — SQL: 2 function(s) (~1662 tok)
- `202605010020_turn_priority_player.sql` — SQL: 1 alter(s), 2 function(s) (~2802 tok)
- `202605010021_blockers_do_not_tap.sql` — SQL: 1 function(s) (~835 tok)
- `202605010022_resolve_combat_damage.sql` — SQL: 3 alter(s), 2 function(s) (~2252 tok)
- `202605010023_parse_power_toughness.sql` — SQL: 1 function(s) (~981 tok)
- `202605010024_win_loss_state.sql` — SQL: 1 alter(s), 4 function(s) (~2254 tok)
- `202605010025_blocked_attacker_damage.sql` — SQL: 3 alter(s), 2 function(s) (~3075 tok)
- `202605010026_lethal_damage_to_graveyard.sql` — SQL: 1 function(s) (~1605 tok)
- `202605010027_blocker_damage_to_attackers.sql` — SQL: 1 function(s) (~1943 tok)
- `202605010028_runtime_state_rls.sql` — SQL: 4 alter(s), 7 function(s) (~3750 tok)
- `202605010029_priority_passing.sql` — SQL: 4 alter(s), 2 function(s) (~2916 tok)
- `202605010030_stack_action_layer.sql` — SQL: tables: public, 1 alter(s), 4 function(s) (~3688 tok)
- `202605010031_stack_action_timing.sql` — SQL: 1 function(s) (~1547 tok)
- `202605010031_zzzz_replayfix_get_stack_items.sql` — Replay fix for clean builds (sorts between 031 and 032). get_stack_items' (~125 tok)
- `202605010032_stack_item_display_details.sql` — SQL: 1 function(s) (~580 tok)
- `202605010032_zzzz_replayfix_get_stack_items.sql` — Replay fix for clean builds (sorts between 032 and 033). See the 031 shim; (~106 tok)
- `202605010033_stack_item_player_name_fallback.sql` — SQL: 1 function(s) (~547 tok)
- `202605010034_mana_cost_and_casting.sql` — SQL: 1 alter(s), 3 function(s) (~3497 tok)
- `202605010035_fix_cast_card_from_hand_row_select.sql` — SQL: 1 function(s) (~888 tok)
- `202605010036_land_play_limit.sql` — SQL: 3 alter(s), 2 function(s) (~3093 tok)
- `202605010037_effect_aware_mana_clearing.sql` — SQL: tables: public, 1 alter(s), 3 function(s) (~3362 tok)
- `202605010038_mana_retention_action.sql` — SQL: 1 function(s) (~1098 tok)
- `202605010039_chosen_generic_mana_payment.sql` — SQL: 3 function(s) (~4042 tok)
- `202605010040_turn_state_display_rpc.sql` — SQL: 1 function(s) (~517 tok)
- `202605010041_permanent_spells_use_stack.sql` — SQL: 4 alter(s), 2 function(s) (~2534 tok)
- `202605010041_zzzz_replayfix_get_turn_state.sql` — Replay fix for clean builds (sorts between 041 and 042). get_turn_state's (~108 tok)
- `202605010042_battlefield_static_effects_land_limit.sql` — SQL: 5 alter(s), 4 function(s) (~3120 tok)
- `202605010043_scripted_continuous_effect_cards.sql` — SQL: 4 function(s) (~4117 tok)
- `202605010044_static_effect_lifecycle_rebuild.sql` — SQL: 3 alter(s), 7 function(s) (~4153 tok)
- `202605010045_real_continuous_effect_cards.sql` (~1031 tok)
- `202605010046_summoning_sickness_and_haste.sql` — SQL: 3 alter(s), 5 function(s) (~5776 tok)
- `202605010047_dev_admin_tools.sql` — SQL: 3 function(s) (~1794 tok)
- `202605010048_vigilance.sql` — SQL: 2 alter(s), 3 function(s) (~2756 tok)
- `202605010048_zzzz_replayfix_get_combat_assignments.sql` — Replay fix for clean builds (sorts between 048 and 049). get_combat_assignments' (~112 tok)
- `202605010049_combat_keywords_and_multiple_blockers.sql` — SQL: tables: public, 3 alter(s), 5 function(s) (~8633 tok)
- `202605010050_first_strike_double_strike.sql` — SQL: 3 alter(s), 5 function(s) (~6235 tok)
- `202605010051_sync_gemini_card_seed.sql` — SQL: 8 alter(s) (~3058 tok)
- `202605010052_blocker_damage_order.sql` — SQL: 3 alter(s), 4 function(s) (~6456 tok)
- `202605010053_counterspell_stack_action.sql` — SQL: 2 function(s) (~3635 tok)
- `202605010054_stack_action_type_counterspell_constraint.sql` — SQL: 2 alter(s) (~78 tok)
- `202605010055_register_keyword_continuous_effects.sql` — SQL: 1 alter(s), 1 function(s) (~1658 tok)
- `202605010056_restore_scripted_card_behaviors.sql` (~1832 tok)
- `202605010057_deck_import_from_text.sql` — SQL: tables: public, 4 alter(s), 1 function(s) (~1210 tok)
- `202605010058_deck_read_policy_own_decks.sql` (~78 tok)
- `202605010059_update_deck_list.sql` — SQL: 1 function(s) (~438 tok)
- `202605010060_fix_deck_import_quantity_parser.sql` — SQL: 1 function(s) (~924 tok)
- `202605010061_deck_owner_id_compat.sql` — SQL: 1 alter(s), 2 function(s) (~1722 tok)
- `202605010062_judge_draw_tools.sql` — 1. Tabel en RLS aanmaken (~6011 tok)
- `202605010063_card_behavior_compat.sql` — SQL: 6 function(s) (~2849 tok)
- `202605010064_flying_and_reach.sql` — Extend effect_type constraint to include flying and reach. (~3605 tok)
- `202605010065_dev_clear_summoning_sickness.sql` — Judge tool: zero out entered_battlefield_turn_number so the creature (~369 tok)
- `202605010066_exile_face_down.sql` — Adds is_face_down boolean column to game_cards for face-down exile tracking (~40 tok) — Judge tool: zero out entered_battlefield_turn_number so the creature (~369 tok)
- `202605010067_deathtouch.sql` — Deathtouch support. (~6295 tok)
- `202605010068_plus_one_counters.sql` — +1/+1 counters. (~4392 tok)
- `202605010068_zzzz_replayfix_get_combat_assignments.sql` — Replay fix for clean builds (sorts between 068 and 069). get_combat_assignments (~111 tok)
- `202605010069_until_end_of_turn_pumps.sql` — Until-end-of-turn power/toughness pumps (Giant Growth style). (~2374 tok)
- `202605010070_tokens.sql` — Token creation. (~1291 tok)
- `202605010071_creature_targeting_spells.sql` — Creature-targeting spells through the stack. (~4577 tok)
- `202605010072_activated_abilities.sql` — Non-mana activated abilities. (~1482 tok)
- `202605010073_dev_pass_priority.sql` — Judge tool: pass priority on behalf of all players. (~487 tok)
- `202605010074_zero_toughness_sba.sql` — State-based action: creatures with 0 or less toughness are put into the (~880 tok)
- `202605010075_card_script_authoring.sql` — Card script authoring (Phase 2 — lightweight approach). (~963 tok)
- `202605010076_triggered_abilities.sql` — Triggered abilities (Phase 3, first slice): enters-the-battlefield and (~4548 tok)
- `202605010076_zzzz_replayfix_get_stack_items.sql` — Replay fix for clean builds (sorts between 076 and 077). get_stack_items is (~108 tok)
- `202605010077_dies_and_attacks_triggers.sql` — Triggered abilities (Phase 3, second slice): dies and attacks events. (~2018 tok)
- `202605010078_trigger_effect_vocabulary.sql` — Widen the triggered-ability effect vocabulary, and refactor resolution so (~3552 tok)
- `202605010079_more_spell_effects.sql` — Phase 3: broaden spell_effect coverage with more effect types (adds add_counters_creature too). (~6300 tok)
- `202605010080_targeted_etb_triggers.sql` — Phase 3: first targeted triggered abilities. triggered_ability stack items can carry target_required/target_card_id; controller picks creature via choose_triggered_ability_creature_target before resolve. Redefines enqueue_triggered_ability + resolve_top_of_stack. (~5200 tok)
- `202605010081_trigger_target_refinements.sql` — Phase 3: refine targeted-creature triggers and spells. (1) creature-ONLY target_type required for a chosen creature target (any-target damage triggers fall through to each_opponent). (2) target_controller (any|opponent|you) enforced via helpers session_has_targetable_creature / creature_target_controller_ok in enqueue/choose/resolve guard/put_action_on_stack. Redefines those 4 fns. (~8240 tok)
- `202605010082_more_trigger_events.sql` — Phase 3: broaden detectable trigger events (all reuse fire_card_triggers). Adds leaves_the_battlefield (fire_zone_change_triggers); beginning_of_draw_step/beginning_of_end_step via new generic fire_turn_step_triggers (replaces fire_upkeep_triggers); blocks (fire_block_triggers on game_combat_blockers insert); becomes_targeted (fire_target_triggers on game_stack_items insert for creature-target actions, lands above targeting item, INSERT-only = loop-free). (~2089 tok)
- `202605010083_exile_and_mill_effects.sql` — Phase 3, Tier 1 effects. exile = targeted creature effect (spell `exile_creature` + triggered `exile`), mirrors destroy to the exile zone; added to constraint, trigger_effect_requires_creature_target, apply_targeted_triggered_ability_effects, put_action_on_stack, resolve_top_of_stack, client CREATURE_EFFECT_MAP. mill = auto trigger effect (recipient controller/each_opponent/each_player) in apply_triggered_ability_effects; trigger-only (no spell-side yet). (~9825 tok)
- `202605010084_put_in_graveyard_chokepoint.sql` — Phase 0 (rules-engine cleanup): single `put_in_graveyard(session, game_card)` primitive for the battlefield→graveyard transition (returns bool; standard leave-battlefield cleanup incl. controller→owner). All three death sites route through it: move_lethal_damaged_creatures_to_graveyard (now snapshots dying set then loops), resolve_top_of_stack destroy_creature, apply_targeted_triggered_ability_effects destroy. The seam for the future finality/death-replacement layer. (~5109 tok)
- `202605010085_effective_script_accessor.sql` — Phase 0 (rules-engine cleanup): single accessor `effective_script(session, game_card)` returning `coalesce(copied_script, cards.script)` (STABLE, SECURITY DEFINER). Routes the 3 live callers through it: register_card_continuous_effects (067), activate_ability (072), fire_card_triggers (077) — each reproduced verbatim with only the inline script-fetch swapped. Behavior-preserving; the one place DFC active-face script selection will later live. (~3663 tok)
- `202605010086_apply_creature_effect.sql` — Phase 0 (rules-engine cleanup): single primitive `apply_creature_effect(session, kind, target, params)` owns every creature mutation (deal_damage/destroy/exile/bounce/tap/untap/add_counters/pump). Collapses the duplicated switch in apply_targeted_triggered_ability_effects (now delegates by effect type) and resolve_top_of_stack (8 `*_creature` branches collapsed into one that strips the `_creature` suffix via regexp and passes the payload). destroy still routes through put_in_graveyard. Behavior-preserving. (~3735 tok)
- `202605010087_finalize_stack_resolution.sql` — Phase 1, slice 1 (prerequisite refactor): extract finalize_stack_resolution. (~2149 tok)
- `202605010088_pending_decisions.sql` — Phase 1, slice 2: the generic "pending decision" state machine + a modal (~4167 tok)
- `202605010089_scry_resolution_decisions.sql` — Phase 1, slice 3: Tier-B resolution-time decisions — scry. (~4752 tok)
- `202605010090_surveil_resolution_decisions.sql` — Phase 1, slice 4: Tier-B resolution-time decision — surveil. (~5159 tok)
- `202605010091_targeted_modal_modes.sql` — Phase 1, slice 5: targeted modal modes. (~5236 tok)
- `202605010092_pending_decisions_realtime.sql` — Phase 1: make game_pending_decisions a realtime source. (~186 tok)
- `202605010093_trigger_scry_surveil.sql` — Phase 1, slice 6: scry / surveil from inside a triggered ability. (~5768 tok)
- `202605010094_spell_effect_program.sql` — Phase 1, slice 7: generic multi-action untargeted spell resolution + the (~6282 tok)
- `202605010095_block_priority_during_decision.sql` — Phase 1, slice 8: a pending decision freezes priority. (~1316 tok)
- `202605010096_more_decisions.sql` — Phase 1, slice 9: more resolution-time choices on the shared decision system — (~5658 tok)
- `202605010097_choose_player.sql` — Phase 1, slice 10: choose_player — pick a player at resolution, then run inner (~5642 tok)

## tests/

- `README.md` — Project documentation (~1405 tok)

## tests/feature/

- `exile-mill.test.ts` — Feature group 083 — exile (spell + targeted trigger) and mill. (~829 tok)
- `modal-decisions.test.ts` — Phase 1, slice 2 — pending-decision machinery + modal "choose one". (~1628 tok)
- `more-decisions.test.ts` — Phase 1, slice 9 — more resolution-time choices: tutor (search_library), (~1660 tok)
- `scry-decisions.test.ts` — Phase 1, slice 3 — Tier-B resolution-time decisions: scry. (~1456 tok)
- `spell-effect-program.test.ts` — Phase 1, slice 7 — multi-action untargeted spell program (e.g. Opt). (~661 tok)
- `surveil-decisions.test.ts` — Phase 1, slice 4 — Tier-B resolution-time decision: surveil. (~1089 tok)
- `targeted-triggers.test.ts` — Feature group 080/081 — targeted ETB triggers, controller (ownership) (~1132 tok)
- `trigger-events.test.ts` — Feature group 082 — the new trigger events: leaves_the_battlefield, (~1320 tok)
- `trigger-scry-surveil.test.ts` — Phase 1, slice 6 — scry / surveil from inside a triggered ability. (~1037 tok)

## tests/fixtures/

- `test-cards.json` (~3698 tok)

## tests/harness/

- `db.ts` — Run `fn` inside a transaction and ALWAYS roll back, so a test leaves no trace. (~1015 tok)
- `scenario.ts` — Create a 2-player session. Seat A is the creator + active player. (~4004 tok)
- `seed.ts` — Seeds the `% Test` cards into public.cards for the local test DB. (~418 tok)

## tests/regression/

- `group1.test.ts` — Group 1 — regression that proves migrations 084/085/086 are behavior-preserving. (~2722 tok)

## tests/unit/

- `card-behavior-builder.test.ts` — Characterization tests for the guided-form ↔ script-JSON conversion in (~6198 tok)

## vercel/

- `.gitignore` — Git ignore rules (~60 tok)
- `components.json` (~128 tok)
- `next.config.mjs` — Next.js configuration (~52 tok)
- `package.json` — Node.js package manifest (~671 tok)
- `pnpm-lock.yaml` — pnpm lock file (~39300 tok)
- `postcss.config.mjs` — Declares config (~41 tok)
- `tsconfig.json` — TypeScript configuration (~178 tok)

## vercel/app/

- `globals.css` — Styles: 7 rules, 103 vars, 2 media queries, 2 animations, 2 layers (~1564 tok)
- `layout.tsx` — _geist (~321 tok)
- `page.tsx` — MTGPage — uses useState (~1275 tok)

## vercel/components/

- `theme-provider.tsx` — ThemeProvider (~87 tok)

## vercel/components/mtg/

- `attack-overlay.tsx` — AttackOverlay (~1305 tok)
- `battlefield-grid.tsx` — BattlefieldGrid — uses useState (~3032 tok)
- `board-view.tsx` — quadrantPositions — renders map — uses useMemo, useEffect (~2682 tok)
- `card-preview.tsx` — manaColorMap (~2033 tok)
- `cockpit.tsx` — Cockpit (~1105 tok)
- `combat-arrows.tsx` — CombatArrows (~963 tok)
- `combat-zone.tsx` — CombatZone (~823 tok)
- `controller-view.tsx` — ControllerView — uses useState, useEffect (~2908 tok)
- `energy-beam.tsx` — EnergyBeam (~726 tok)
- `hand-fan.tsx` — HandFan — uses useState, useCallback (~2571 tok)
- `index.ts` — MTG Components (~200 tok)
- `mana-economy.tsx` — manaOrder (~865 tok)
- `mana-orb.tsx` — manaColors (~784 tok)
- `minimap-widget.tsx` — positionClasses (~761 tok)
- `mtg-card.tsx` — sizeClasses (~822 tok)
- `player-quadrant.tsx` — positionClasses (~1309 tok)

## vercel/components/ui/

- `accordion.tsx` — Accordion (~606 tok)
- `alert-dialog.tsx` — AlertDialog (~1150 tok)
- `alert.tsx` — alertVariants (~481 tok)
- `aspect-ratio.tsx` — AspectRatio (~84 tok)
- `avatar.tsx` — Avatar (~330 tok)
- `badge.tsx` — badgeVariants (~480 tok)
- `breadcrumb.tsx` — Breadcrumb (~705 tok)
- `button-group.tsx` — buttonGroupVariants (~656 tok)
- `button.tsx` — buttonVariants (~630 tok)
- `calendar.tsx` — Calendar — uses useEffect (~2255 tok)
- `card.tsx` — Card (~595 tok)
- `carousel.tsx` — CarouselContext — uses useContext, useState, useCallback, useEffect (~1658 tok)
- `chart.tsx` — THEMES — renders chart — uses useContext, useMemo (~2888 tok)
- `checkbox.tsx` — Checkbox (~360 tok)
- `collapsible.tsx` — Collapsible (~238 tok)
- `command.tsx` — Command — renders modal (~1431 tok)
- `context-menu.tsx` — ContextMenu (~2439 tok)
- `dialog.tsx` — Dialog — renders modal (~1180 tok)
- `drawer.tsx` — Drawer — renders modal (~1256 tok)
- `dropdown-menu.tsx` — DropdownMenu (~2483 tok)
- `empty.tsx` — Empty (~716 tok)
- `field.tsx` — FieldSet — uses useMemo (~1800 tok)
- `form.tsx` — Form — renders form — uses useContext (~1123 tok)
- `hover-card.tsx` — HoverCard (~451 tok)
- `input-group.tsx` — InputGroup (~1486 tok)
- `input-otp.tsx` — InputOTP — uses useContext (~667 tok)
- `input.tsx` — Input (~282 tok)
- `item.tsx` — ItemGroup (~1342 tok)
- `kbd.tsx` — Kbd (~255 tok)
- `label.tsx` — Label (~182 tok)
- `menubar.tsx` — Menubar (~2480 tok)
- `navigation-menu.tsx` — NavigationMenu (~1948 tok)
- `pagination.tsx` — Pagination (~812 tok)
- `popover.tsx` — Popover (~482 tok)
- `progress.tsx` — Progress (~221 tok)
- `radio-group.tsx` — RadioGroup (~432 tok)
- `resizable.tsx` — ResizablePanelGroup (~596 tok)
- `scroll-area.tsx` — ScrollArea (~487 tok)
- `select.tsx` — Select (~1842 tok)
- `separator.tsx` — Separator (~208 tok)
- `sheet.tsx` — Sheet (~1209 tok)
- `sidebar.tsx` — SIDEBAR_COOKIE_NAME — uses useContext, useState, useCallback, useEffect (~6393 tok)
- `skeleton.tsx` — Skeleton (~83 tok)
- `slider.tsx` — Slider — uses useMemo (~572 tok)
- `sonner.tsx` — Toaster (~169 tok)
- `spinner.tsx` — Spinner (~100 tok)
- `switch.tsx` — Switch (~338 tok)
- `table.tsx` — Table — renders table (~734 tok)
- `tabs.tsx` — Tabs (~582 tok)
- `textarea.tsx` — Textarea (~223 tok)
- `toast.tsx` — ToastProvider (~1427 tok)
- `toaster.tsx` — Toaster (~235 tok)
- `toggle-group.tsx` — ToggleGroupContext — uses useContext (~572 tok)
- `toggle.tsx` — toggleVariants (~463 tok)
- `tooltip.tsx` — TooltipProvider (~559 tok)
- `use-mobile.tsx` — MOBILE_BREAKPOINT — uses useEffect (~167 tok)
- `use-toast.ts` — Exports reducer (~1182 tok)

## vercel/hooks/

- `use-mobile.ts` — Exports useIsMobile (~167 tok)
- `use-toast.ts` — Exports reducer (~1182 tok)

## vercel/lib/

- `utils.ts` — Exports cn (~50 tok)

## vercel/lib/mtg/

- `game-context.tsx` — createMockPlayer — uses useCallback, useContext (~2844 tok)
- `types.ts` — MTG Game Types (~559 tok)

## vercel/styles/

- `globals.css` — Styles: 6 rules, 103 vars, 1 layers (~1280 tok)
