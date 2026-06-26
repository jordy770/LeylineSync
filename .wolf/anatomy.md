# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-06-26T15:27:35.581Z
> Files: 126 tracked | Anatomy hits: 0 | Misses: 0

## ../../.claude/plans/


## ../../.claude/projects/C--Users-Jordy-dev-LeylineSync/memory/

- `local-migrations.md` — Declares migrations (~422 tok)
- `MEMORY.md` (~191 tok)
- `opponent-view-design.md` (~1115 tok)

## ../../.cloudflared/

- `config.yml` — Cloudflare Tunnel ingress for the LeylineSync dev server. (~294 tok)

## ../../AppData/Local/Temp/claude/C--Users-Jordy-dev-LeylineSync/29ade7df-e915-4e92-91d0-74481e09da2e/scratchpad/

- `dpfix.mjs` — Declares p (~507 tok)
- `fix.mjs` — Declares p (~853 tok)
- `tier1.mjs` — Declares root (~536 tok)
- `tokens.mjs` — Declares root (~501 tok)

## ./

- `_verify_tmp.mts` — file: diff (~406 tok)
- `.gitignore` — Git ignore rules (~370 tok)

## .claude/


## .claude/projects/c--Users-Jordy-dev-LeylineSync/memory/

- `project_roadmap.md` — LeylineSync — Combined Roadmap (as of 2026-06-04) (~13609 tok)

## .claude/rules/


## .claude/workflows/


## .git/


## Phase 1 Tier-B scry (added 2026-06-02)


## app/

- `globals.css` — Styles: 7 rules, 70 vars (~2206 tok)

## app/api/cards/generate-behavior/


## app/auth/confirm/


## app/auth/error/


## app/auth/forgot-password/


## app/auth/login/


## app/auth/sign-up-success/


## app/auth/sign-up/


## app/auth/update-password/


## app/board/[id]/


## app/cards/behavior/


## app/controller-style-lab/


## app/controller/[id]/


## app/decks/


## app/judge/[id]/


## app/manifest.webmanifest/


## app/protected/


## app/style-guide/


## components/

- `ControllerListV5.tsx` — The mana an untapped card auto-produces when it has exactly one simple (~70146 tok)
- `GameBoard.tsx` — GameBoard (~7302 tok)
- `GameLogPanel.tsx` — Shared self-contained game-log overlay (own supabase client + game_action_log realtime); used by GameBoard. Controller has its own GameLogSheet (~1215 tok)
- `GameSessionLobby.tsx` — GameSessionLobby (~12039 tok)

## components/board/

- `BoardViewChrome.tsx` — BoardViewChrome (~885 tok)
- `GameFinishedOverlay.tsx` — GameFinishedOverlay (~1180 tok)

## components/controller/

- `CardActionSheet.tsx` — CardActionSheet (~19181 tok)

## components/judge/


## components/layout/


## components/tutorial/


## components/ui/


## docs/

- `backlog.md` — Backlog (~169 tok)
- `client-coverage-audit.md` — Client coverage audit — engine vs UI (~1657 tok)
- `open-items.md` — Open items — merged & verified (~1535 tok)

## docs/commander-decks/


## lib/


## lib/game/

- `actions.ts` — Exports getErrorMessage, setCardTapped, moveCardToZone, castCardFromHand + 25 more (~13002 tok)
- `auto-pass.ts` — You are the active (turn) player. (~1508 tok)
- `bot-brain.ts` — Pure AI-bot heuristics: mulligan, main-phase plays, and keyword-aware combat (decideAttacks/decideBlocks honour evasion/menace/trample/first-strike/deathtouch + defensive reserves). (~3013 tok)
- `card-behavior-schema.ts` — ─── Shared primitives ─────────────────────────────────────────────────────── (~21023 tok)
- `data.ts` — Exports emptyManaPool, gameZones, gameSessionStatuses, turnPhases + 11 more (~10131 tok)
- `mana-sources.ts` — What mana colours a permanent can make, collapsed for the controller's own (~1293 tok)
- `mana.ts` — Exports manaColors, ManaPayment, ParsedManaCost, parseManaCost + 5 more (~830 tok)
- `types.ts` — Exports ManaPool, RestrictedManaEntry, ManaColor, GameZone + 30 more (~3023 tok)
- `use-board-game-state.ts` — Exports useBoardGameState (~1762 tok)
- `use-controller-game-state.ts` — Exports useControllerGameState (~3108 tok)

## lib/supabase/

- `client.ts` — Exports createClient (~66 tok)

## mockups/

- `damage-display-concepts.html` — LeylineSync · Commander- & toxic-damage weergave (~2795 tok)
- `opponent-keyword-icons.html` — LeylineSync · Keyword icon-opties (game-icons) (~1738 tok)
- `opponent-view-concepts.html` — LeylineSync · Opponent View — concepts (~5478 tok)
- `opponent-view-flow.html` — LeylineSync · Opponent flow (~7380 tok)
- `opponent-view-threat-rail.html` — LeylineSync · Threat Rail — icons (~6757 tok)

## public/


## scripts/

- `bot-runner.mjs` — Plain read as the postgres session role (RLS bypassed) — used for polling. (~8239 tok)
- `triage-decklist.mjs` — Decklist triage — the planning step before implementing a deck's cards. (~3696 tok)

## supabase/


## supabase/functions/spawn-deck/


## supabase/functions_src/

- `activate_ability.sql` — supabase/functions_src/activate_ability.sql (~9219 tok)
- `advance_step.sql` — supabase/functions_src/advance_step.sql (~3941 tok)
- `apply_creature_effect.sql` — supabase/functions_src/apply_creature_effect.sql (~7227 tok)
- `apply_damage_to_creature.sql` — supabase/functions_src/apply_damage_to_creature.sql (~1815 tok)
- `apply_damage_to_player.sql` — supabase/functions_src/apply_damage_to_player.sql (~1067 tok)
- `apply_trigger_effects.sql` — supabase/functions_src/apply_trigger_effects.sql (~21900 tok)
- `apply_triggered_ability_effects.sql` — supabase/functions_src/apply_triggered_ability_effects.sql (~13308 tok)
- `card_has_defender.sql` — supabase/functions_src/card_has_defender.sql (~563 tok)
- `card_has_fear.sql` — supabase/functions_src/card_has_fear.sql (~502 tok)
- `card_has_flying.sql` — supabase/functions_src/card_has_flying.sql (~639 tok)
- `card_layered_power.sql` — supabase/functions_src/card_layered_power.sql (~1547 tok)
- `card_layered_toughness.sql` — supabase/functions_src/card_layered_toughness.sql (~1559 tok)
- `cast_card_from_hand.sql` — supabase/functions_src/cast_card_from_hand.sql (~5990 tok)
- `choose_triggered_ability_creature_target.sql` — supabase/functions_src/choose_triggered_ability_creature_target.sql (~1105 tok)
- `clear_deck_from_session.sql` — supabase/functions_src/clear_deck_from_session.sql (~471 tok)
- `create_copy_token.sql` — supabase/functions_src/create_copy_token.sql (~1650 tok)
- `declare_attacker.sql` — supabase/functions_src/declare_attacker.sql (~3458 tok)
- `declare_blocker.sql` — supabase/functions_src/declare_blocker.sql (~1908 tok)
- `effective_script.sql` — supabase/functions_src/effective_script.sql (~624 tok)
- `enqueue_triggered_ability.sql` — supabase/functions_src/enqueue_triggered_ability.sql (~1699 tok)
- `fire_attack_triggers.sql` — supabase/functions_src/fire_attack_triggers.sql (~495 tok)
- `fire_lifegain_triggers.sql` — supabase/functions_src/fire_lifegain_triggers.sql (~658 tok)
- `fire_watcher_triggers.sql` — supabase/functions_src/fire_watcher_triggers.sql (~3449 tok)
- `get_session_players.sql` — supabase/functions_src/get_session_players.sql (~464 tok)
- `get_stack_items.sql` — supabase/functions_src/get_stack_items.sql (~1080 tok)
- `get_turn_state.sql` — supabase/functions_src/get_turn_state.sql (~785 tok)
- `handle_permanent_effect.sql` — supabase/functions_src/handle_permanent_effect.sql (~1902 tok)
- `library_top_is_color.sql` — supabase/functions_src/library_top_is_color.sql (~260 tok)
- `put_in_graveyard.sql` — supabase/functions_src/put_in_graveyard.sql (~1542 tok)
- `register_card_continuous_effects.sql` — supabase/functions_src/register_card_continuous_effects.sql (~2768 tok)
- `reset_mana.sql` — supabase/functions_src/reset_mana.sql (~512 tok)
- `resolve_count_amount.sql` — supabase/functions_src/resolve_count_amount.sql (~3832 tok)
- `submit_decision.sql` — supabase/functions_src/submit_decision.sql (~14917 tok)
- `trigger_effect_target_type.sql` — supabase/functions_src/trigger_effect_target_type.sql (~410 tok)

## supabase/migrations/

- `202605010323_defender_keyword.sql` — 202605010323_defender_keyword (~6859 tok)
- `202605010324_clear_deck_from_session.sql` — 202605010324_clear_deck_from_session (~468 tok)
- `202605010325_cast_watcher_not_self.sql` — 202605010325_cast_watcher_not_self (~3475 tok)
- `202605010326_optional_trigger_targets.sql` — 202605010326_optional_trigger_targets (~23518 tok)
- `202605010326_stack_bot_username.sql` — 202605010326_stack_bot_username (~1517 tok)
- `202605010327_realtime_game_tables.sql` — 202605010327_realtime_game_tables (~302 tok)
- `202605010327_shock_lands.sql` — 202605010327_shock_lands (~19923 tok)
- `202605010328_turn_state_bot_name.sql` — 202605010328_turn_state_bot_name (~850 tok)
- `202605010330_game_log.sql` — 202605010330_game_log (~784 tok)
- `202605010331_game_log_outcomes.sql` — 202605010331_game_log_outcomes (~876 tok)
- `202605010334_draw_floor_fix.sql` — 202605010334_draw_floor_fix (~12656 tok)
- `202605010335_tap_self.sql` — 202605010335_tap_self (~12774 tok)
- `202605010336_lifegain_event.sql` — 202605010336_lifegain_event (~31899 tok)
- `202605010337_choose_type_anthem.sql` — 202605010337_choose_type_anthem (~14178 tok)
- `202605010338_fear.sql` — 202605010338_fear (~5325 tok)
- `202605010339_reflexive_may_program.sql` — 202605010339_reflexive_may_program (~35175 tok)

## supabase/migrations/ (200-215, 2026-06-10)


## tests/


## tests/feature/

- `blade-of-selves.test.ts` — Blade of Selves (mig 357). "Equipped creature has myriad." Built on the new (~598 tok)
- `carmen.test.ts` — Carmen, Cruel Skymarcher (mig 341). Two new pieces: (~914 tok)
- `cast-watcher-self.test.ts` — Cast-watcher self-trigger (mig 325) — a "whenever you cast a creature spell" (~663 tok)
- `change-deck.test.ts` — Lobby "change deck" (mig 324) — clear_deck_from_session lets a player undo a (~744 tok)
- `choose-type-anthem.test.ts` — choose_creature_type → persistent anthem (mig 337). A "choose a creature type" (~998 tok)
- `clavileno.test.ts` — Clavileño, First of the Blessed (mig 344). "Whenever you attack, target (~1066 tok)
- `conjurers-closet.test.ts` — Conjurer's Closet (mig 351). "At the beginning of your end step, you may exile (~496 tok)
- `copy-token-cleanup.test.ts` — Copy-token end-step cleanup (mig 347). The copy_permanent action already makes (~842 tok)
- `deck-smoke.test.ts` — Deck smoke test: every curated script in docs/commander-decks/card-scripts.json (~2795 tok)
- `defender.test.ts` — Defender enforcement (mig 323) — "a creature with defender can't attack." (~549 tok)
- `draw-floor.test.ts` — Draw-floor fix (mig 334). The draw branch of apply_triggered_ability_effects (~767 tok)
- `fear.test.ts` — Fear keyword (mig 338). Cover of Darkness: "As this enters, choose a creature (~1062 tok)
- `flameshadow.test.ts` — Flameshadow Conjuring (mig 352). "Whenever a nontoken creature you control (~737 tok)
- `harmless-offering.test.ts` — Harmless Offering (mig 353). "Target opponent gains control of target permanent (~380 tok)
- `helm-of-the-host.test.ts` — Helm of the Host (mig 350). "At the beginning of combat on your turn, create a (~537 tok)
- `jaxis.test.ts` — Jaxis, the Troublemaker (mig 349). Activated copy (reusing Orthion's path) where (~733 tok)
- `lifegain-event.test.ts` — you_gain_life triggered event (mig 336). Marauding Blight-Priest: "Whenever (~695 tok)
- `mayhem-devil.test.ts` — Mayhem Devil — already engine-supported once mig 341 added the (~528 tok)
- `mirror-march.test.ts` — Mirror March (mig 354). "Whenever a nontoken creature you control enters, flip a (~797 tok)
- `myriad.test.ts` — Myriad (mig 355). "Whenever this attacks, for each opponent other than the (~826 tok)
- `optional-trigger-target.test.ts` — Optional ("up to one target …") triggered-ability targets (mig 326). A trigger (~675 tok)
- `orthion.test.ts` — Orthion, Hero of Lavabrink (mig 348). Copy a creature you control from an (~710 tok)
- `patriarchs-bidding.test.ts` — Patriarch's Bidding (mig 343). "Each player chooses a creature type. Each (~794 tok)
- `reanimate.test.ts` — Reanimate / Animate Dead (mig 346). The reanimation is return_from_graveyard (~798 tok)
- `reflexive-may-program.test.ts` — Reflexive "when you do" via may + program (mig 339). Ruthless Lawbringer: (~1062 tok)
- `return-on-death.test.ts` — Return-on-death (mig 345). Feign Death / Not Dead After All / Supernatural (~819 tok)
- `saw-in-half.test.ts` — Saw in Half (mig 356). "Destroy target creature. If that creature dies this way, (~566 tok)
- `shared-animosity.test.ts` — Shared Animosity (mig 340). "Whenever a creature you control attacks, it gets (~953 tok)
- `shock-land.test.ts` — Shock lands (mig 327) — "enters tapped UNLESS you pay 2 life". Playing one puts (~854 tok)
- `splinter-twin.test.ts` — Splinter Twin (mig 358). "Enchant creature. Enchanted creature has '{T}: create a (~578 tok)
- `tap-self.test.ts` — tap_self effect action (mig 335). "Tap it" taps the SOURCE permanent — the (~779 tok)
- `vampire-nocturnus.test.ts` — Vampire Nocturnus (mig 342). Conditional tribal anthem: "as long as the top (~851 tok)

## tests/fixtures/

- `test-cards.json` (~43873 tok)

## tests/harness/


## tests/regression/


## tests/unit/

- `auto-pass.test.ts` — shouldAutoPass — the controller's pure "should I pass priority right now?" (~2653 tok)
- `bot-brain.test.ts` — bot-brain — the AI CPU's pure heuristic decisions (lib/game/bot-brain). Each (~2536 tok)
- `registry-schema-drift.test.ts` — Drift guard for the card-behavior authoring stack's two type vocabularies: (~3078 tok)

## vercel/


## vercel/app/


## vercel/components/


## vercel/components/mtg/


## vercel/components/ui/


## vercel/hooks/


## vercel/lib/


## vercel/lib/mtg/


## vercel/styles/

