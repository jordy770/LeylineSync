# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-07-03T12:26:41.710Z
> Files: 247 tracked | Anatomy hits: 0 | Misses: 0

## ../../.claude/plans/


## ../../.claude/projects/C--Users-Jordy-dev-LeylineSync/memory/

- `collection-optimizer-module.md` (~4794 tok)
- `decisive-over-clarifying.md` (~269 tok)
- `local-migrations.md` — Declares migrations (~422 tok)
- `MEMORY.md` (~273 tok)
- `never-purge-user-data.md` (~318 tok)
- `opponent-view-design.md` — Declares form (~1368 tok)

## ../../.cloudflared/

- `config.yml` — Cloudflare Tunnel ingress for the LeylineSync dev server. (~294 tok)

## ../../AppData/Local/Temp/claude/C--Users-Jordy-dev-LeylineSync/29ade7df-e915-4e92-91d0-74481e09da2e/scratchpad/

- `dpfix.mjs` — Declares p (~507 tok)
- `fix.mjs` — Declares p (~853 tok)
- `tier1.mjs` — Declares root (~536 tok)
- `tokens.mjs` — Declares root (~501 tok)

## ../../AppData/Local/Temp/claude/C--Users-Jordy-dev-LeylineSync/a403f535-8b14-4f77-9426-b571a70d18cf/scratchpad/

- `log-alphinaud.cjs` — Declares fs (~466 tok)
- `log-bugs.cjs` — Declares fs (~778 tok)
- `log-dualcast.cjs` — Declares fs (~490 tok)
- `log-perf.cjs` — Declares fs (~487 tok)
- `rt-test.mjs` — Node has no global WebSocket in some versions; supabase-realtime needs one. (~498 tok)

## ../../AppData/Local/Temp/claude/C--Users-Jordy-dev-LeylineSync/b3467b9f-c3ab-4823-9620-fb93c878b451/scratchpad/

- `validate-mig.mjs` — Declares sql (~326 tok)

## ./

- `_co_actions_e2e_tmp.mjs` — Declares LOCAL_URL (~771 tok)
- `_co_ai_e2e_tmp.mjs` — Declares DB (~744 tok)
- `_co_apply_tmp.mjs` — Declares sql (~228 tok)
- `_co_bc_e2e_tmp.mjs` — Declares DB (~789 tok)
- `_co_check_tmp.mjs` — Declares client (~175 tok)
- `_co_deck_e2e_tmp.mjs` — Declares LOCAL_URL (~636 tok)
- `_co_e2e_tmp.mjs` — Declares LOCAL_URL (~829 tok)
- `_co_scan_e2e_tmp.mjs` — LOCAL_URL: oid (~838 tok)
- `_rt_race_tmp.mjs` — URL: mint (~531 tok)
- `_rt_test2_tmp.mjs` — URL: b64url, mintJwt (~674 tok)
- `_rt_test3_tmp.mjs` — URL: mint (~672 tok)
- `_rt_test4_tmp.mjs` — Declares URL (~484 tok)
- `_scan_ff_tmp.mjs` — Declares deck (~554 tok)
- `_verify_bs_tmp.mjs` — Declares c (~605 tok)
- `_verify_cs_tmp.mjs` — Declares c (~832 tok)
- `_verify_tmp.mts` — file: diff (~406 tok)
- `.gitignore` — Git ignore rules (~370 tok)
- `image-loader.ts` — Scryfall's image CDN now rejects requests sent with a default HTTP-library (~226 tok)
- `next.config.ts` — Pin the workspace root to this project. A stray parent lockfile (~506 tok)
- `package.json` — Node.js package manifest (~578 tok)

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


## app/api/collection/import/

- `route.ts` — POST /api/collection/import (~576 tok)

## app/api/collection/move-card/

- `route.ts` — POST /api/collection/move-card (~403 tok)

## app/api/conflicts/

- `route.ts` — GET /api/conflicts → cards committed to more decks than the player owns copies of. (~232 tok)

## app/api/decks/[id]/analysis/

- `route.ts` — GET /api/decks/:id/analysis  → power score + buckets + curve (cached to co_deck_analyses) (~310 tok)

## app/api/decks/[id]/buy/

- `route.ts` — GET /api/decks/:id/buy?budget=5   (budget omitted / 0 = no cap) (~366 tok)

## app/api/decks/[id]/recommend/

- `route.ts` — POST /api/decks/:id/recommend (~469 tok)

## app/api/decks/[id]/swaps/

- `route.ts` — POST /api/decks/:id/swaps (~413 tok)

## app/api/decks/[id]/upgrades/

- `route.ts` — GET /api/decks/:id/upgrades (~363 tok)

## app/api/decks/import/

- `route.ts` — POST /api/decks/import (~876 tok)

## app/auth/confirm/


## app/auth/error/


## app/auth/forgot-password/


## app/auth/login/


## app/auth/sign-up-success/


## app/auth/sign-up/


## app/auth/update-password/


## app/board/[id]/

- `page.tsx` — BoardPage (~422 tok)

## app/cards/behavior/


## app/collection/

- `page.tsx` — dynamic (~2530 tok)

## app/collection/conflicts/

- `page.tsx` — dynamic (~793 tok)

## app/collection/decks/[id]/

- `page.tsx` — dynamic (~342 tok)

## app/collection/decks/import/

- `page.tsx` — dynamic (~184 tok)

## app/collection/import/

- `page.tsx` — dynamic (~185 tok)

## app/collection/insights/

- `page.tsx` — dynamic (~1543 tok)

## app/controller-style-lab/


## app/controller/[id]/


## app/decks/


## app/judge/[id]/


## app/manifest.webmanifest/


## app/protected/


## app/style-guide/


## components/

- `ControllerListV5.tsx` — The mana an untapped card auto-produces when it has exactly one simple (~70288 tok)
- `GameBoard.tsx` — GameBoard (~7302 tok)
- `GameLogPanel.tsx` — Shared self-contained game-log overlay (own supabase client + game_action_log realtime); used by GameBoard. Controller has its own GameLogSheet (~1215 tok)
- `GameSessionLobby.tsx` — GameSessionLobby (~12039 tok)
- `SiteNav.tsx` — Shared top nav so the landing and decks pages wear the same identity. (~457 tok)

## components/board/

- `BoardViewChrome.tsx` — BoardViewChrome (~885 tok)
- `GameFinishedOverlay.tsx` — GameFinishedOverlay (~1180 tok)

## components/collection/

- `DeckDetail.tsx` — BUCKET_ORDER (~6709 tok)
- `DeckImportForm.tsx` — DeckImportForm (~1390 tok)
- `ImportWizard.tsx` — ImportWizard (~1446 tok)
- `Shell.tsx` — Color-identity pips rendered as small mana-coloured dots. (~881 tok)

## components/controller/

- `CardActionSheet.tsx` — CardActionSheet (~19181 tok)
- `KeywordIcon.tsx` — AUTO-GENERATED keyword icon set (game-icons.net, CC-BY 3.0, via Iconify). (~6101 tok)
- `shared.ts` — Collects displayable keywords for a card from Scryfall keywords + scripted continuous effects. (~10516 tok)

## components/judge/


## components/layout/


## components/tutorial/


## components/ui/


## docs/

- `backlog.md` — Backlog (~169 tok)
- `client-coverage-audit.md` — Client coverage audit — engine vs UI (~1657 tok)
- `open-items.md` — Open items — merged & verified (~1535 tok)

## docs/collection-optimizer/

- `ARCHITECTURE.md` — Collection-Aware Commander Deck Optimizer — Architecture (~5331 tok)

## docs/commander-decks/

- `card-scripts.json` (~99253 tok)

## lib/


## lib/collection/

- `ai-recommend.ts` — Flatten the scan's free + occupied upgrades into one candidate list (deduped). (~2828 tok)
- `analyze-deck.ts` — Deck analysis: load → score → (optionally) cache the result in co_deck_analyses. (~339 tok)
- `apply-swap.ts` — Apply a free upgrade: cut OUT (optional) and add IN to a deck. The physical card (~644 tok)
- `buy-suggestions.ts` — A Scryfall exact-name search link — the brief uses Scryfall for card info/pricing. (~1358 tok)
- `conflicts.ts` — Pure: an oracle is a conflict when its committed copies exceed owned copies. (~858 tok)
- `dashboard.ts` — Pure: the strongest unused binder cards — high-synergy cards sitting idle. (~1400 tok)
- `deck-loader.ts` — oracle_id → distinct binder name(s) the player's FREE copies sit in (for "go find it"). (~1564 tok)
- `deck-mutations.ts` — Returns false if the card wasn't in the deck to begin with. (~622 tok)
- `fetch-decklist.ts` — Pure: identify the site + deck id from a pasted URL. (~1541 tok)
- `import-collection.ts` — Collection import orchestration: parse → resolve to oracle_id → persist. (~1336 tok)
- `import-deck.ts` — Deck import orchestration: parse decklist → resolve to oracle_ids → persist a (~1585 tok)
- `insights.ts` — Pure: rank the binder candidates that fit ONE deck (colour-legal, fills a need), (~1684 tok)
- `move-card.ts` — Move a card from one deck to another (resolves an "occupied" upgrade — you own (~626 tok)
- `power-score.ts` — Power score — a transparent, deterministic 0–10 rating of a Commander deck from (~2172 tok)
- `resolve.ts` — The minimum a row needs to be resolvable. (~864 tok)
- `scoring.ts` — The deck's archetype tags — non-staple roles that appear on enough cards to be a (~1481 tok)
- `types.ts` — One physical stack of cards as parsed from an import file (pre-resolution). (~652 tok)
- `upgrade-scanner.ts` — colorIdentity ⊆ deckIdentity (~3803 tok)

## lib/collection/parsers/

- `decklist.ts` — Returns the section this header switches to, or null if the line isn't a header. (~1193 tok)
- `manabox.ts` — ManaBox collection CSV parser — pure, no I/O. (~1583 tok)

## lib/collection/synergy/

- `tagger.ts` — Synergy tagger — pure heuristics that turn a card's oracle text/type/keywords (~2053 tok)

## lib/game/

- `actions.ts` — Exports getErrorMessage, setCardTapped, moveCardToZone, castCardFromHand + 25 more (~13067 tok)
- `auto-pass.ts` — You are the active (turn) player. (~1508 tok)
- `bot-brain.ts` — Pure AI-bot heuristics: mulligan, main-phase plays, and keyword-aware combat (decideAttacks/decideBlocks honour evasion/menace/trample/first-strike/deathtouch + defensive reserves). (~3013 tok)
- `card-behavior-schema.ts` — ─── Shared primitives ─────────────────────────────────────────────────────── (~21611 tok)
- `data.ts` — Exports emptyManaPool, gameZones, gameSessionStatuses, turnPhases + 3 more (~13767 tok)
- `mana-sources.ts` — What mana colours a permanent can make, collapsed for the controller's own (~1293 tok)
- `mana.ts` — Exports manaColors, ManaPayment, ParsedManaCost, parseManaCost + 5 more (~830 tok)
- `types.ts` — Exports ManaPool, RestrictedManaEntry, ManaColor, GameZone + 30 more (~3023 tok)
- `use-board-game-state.ts` — Exports useBoardGameState (~2087 tok)
- `use-controller-game-state.ts` — Exports useControllerGameState (~3406 tok)

## lib/supabase/

- `client.ts` — Exports createClient (~342 tok)

## mockups/

- `damage-display-concepts.html` — LeylineSync · Commander- & toxic-damage weergave (~2795 tok)
- `opponent-keyword-icons.html` — LeylineSync · Keyword icon-opties (game-icons) (~1738 tok)
- `opponent-view-concepts.html` — LeylineSync · Opponent View — concepts (~5478 tok)
- `opponent-view-flow.html` — LeylineSync · Opponent flow (~7380 tok)
- `opponent-view-threat-rail.html` — LeylineSync · Threat Rail — icons (~6757 tok)

## public/


## scripts/

- `bot-runner.mjs` — Plain read as the postgres session role (RLS bypassed) — used for polling. (~8239 tok)
- `import-card-printings.mjs` — Import Scryfall bulk card data into public.co_card_printings (Collection Optimizer). (~2856 tok)
- `tag-backfill.mjs` — Backfill co_card_tags by running the synergy tagger over every oracle card. (~1075 tok)
- `triage-decklist.mjs` — Decklist triage — the planning step before implementing a deck's cards. (~3815 tok)
- `upsert-deck-scripts.mjs` — Upsert a decklist's behavior scripts onto the HOSTED card catalog (~2440 tok)

## supabase/


## supabase/functions/spawn-deck/


## supabase/functions_src/

- `activate_ability.sql` — supabase/functions_src/activate_ability.sql (~9314 tok)
- `advance_step.sql` — supabase/functions_src/advance_step.sql (~3941 tok)
- `apply_creature_effect.sql` — supabase/functions_src/apply_creature_effect.sql (~7227 tok)
- `apply_damage_to_creature.sql` — supabase/functions_src/apply_damage_to_creature.sql (~1815 tok)
- `apply_damage_to_player.sql` — supabase/functions_src/apply_damage_to_player.sql (~1067 tok)
- `apply_trigger_effects.sql` — supabase/functions_src/apply_trigger_effects.sql (~22233 tok)
- `apply_triggered_ability_effects.sql` — supabase/functions_src/apply_triggered_ability_effects.sql (~13568 tok)
- `build_stack_payload_permanent_simple.sql` — supabase/functions_src/build_stack_payload_permanent_simple.sql (~784 tok)
- `card_has_defender.sql` — supabase/functions_src/card_has_defender.sql (~563 tok)
- `card_has_fear.sql` — supabase/functions_src/card_has_fear.sql (~502 tok)
- `card_has_flying.sql` — supabase/functions_src/card_has_flying.sql (~639 tok)
- `card_has_lifelink.sql` — supabase/functions_src/card_has_lifelink.sql (~577 tok)
- `card_layered_power.sql` — supabase/functions_src/card_layered_power.sql (~1659 tok)
- `card_layered_toughness.sql` — supabase/functions_src/card_layered_toughness.sql (~1671 tok)
- `cast_card_from_hand.sql` — supabase/functions_src/cast_card_from_hand.sql (~5990 tok)
- `choose_triggered_ability_creature_target.sql` — supabase/functions_src/choose_triggered_ability_creature_target.sql (~1105 tok)
- `clear_deck_from_session.sql` — supabase/functions_src/clear_deck_from_session.sql (~471 tok)
- `create_copy_token.sql` — supabase/functions_src/create_copy_token.sql (~1650 tok)
- `declare_attacker.sql` — supabase/functions_src/declare_attacker.sql (~3458 tok)
- `declare_blocker.sql` — supabase/functions_src/declare_blocker.sql (~1908 tok)
- `effective_script.sql` — supabase/functions_src/effective_script.sql (~624 tok)
- `enqueue_triggered_ability.sql` — supabase/functions_src/enqueue_triggered_ability.sql (~1699 tok)
- `fire_attack_triggers.sql` — supabase/functions_src/fire_attack_triggers.sql (~547 tok)
- `fire_lifegain_triggers.sql` — supabase/functions_src/fire_lifegain_triggers.sql (~658 tok)
- `fire_watcher_triggers.sql` — supabase/functions_src/fire_watcher_triggers.sql (~3716 tok)
- `get_board_state.sql` — Board counterpart of get_controller_state: one security-definer RPC returning the big-screen view as jsonb (session/turn/players/combat/stack/commander-damage/animated+attack_tax status/all-players board_cards with catalog joined). ~8 reads → 1. Client maps it in getBoardState (lib/game/data.ts). (~1014 tok)
- `get_controller_state.sql` — One security-definer RPC returning the WHOLE controller view as jsonb (session/turn/players/combat/stack/decisions/mana/commander-damage/board+controller cards with catalog joined/raw continuous_effects). Replaces ~19 PostgREST reads/reload. Client maps it in getControllerState (lib/game/data.ts). (~1659 tok)
- `get_session_players.sql` — supabase/functions_src/get_session_players.sql (~464 tok)
- `get_stack_items.sql` — supabase/functions_src/get_stack_items.sql (~1080 tok)
- `get_turn_state.sql` — supabase/functions_src/get_turn_state.sql (~785 tok)
- `handle_permanent_effect.sql` — supabase/functions_src/handle_permanent_effect.sql (~2519 tok)
- `library_top_is_color.sql` — supabase/functions_src/library_top_is_color.sql (~260 tok)
- `note_spell_cast.sql` — supabase/functions_src/note_spell_cast.sql (~332 tok)
- `put_in_graveyard.sql` — supabase/functions_src/put_in_graveyard.sql (~1542 tok)
- `reduced_mana_cost.sql` — supabase/functions_src/reduced_mana_cost.sql (~1178 tok)
- `register_card_continuous_effects.sql` — supabase/functions_src/register_card_continuous_effects.sql (~2877 tok)
- `reset_mana.sql` — supabase/functions_src/reset_mana.sql (~512 tok)
- `resolve_count_amount.sql` — supabase/functions_src/resolve_count_amount.sql (~3970 tok)
- `submit_decision.sql` — supabase/functions_src/submit_decision.sql (~15100 tok)
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
- `202605010362_harmless_offering_cast.sql` — 202605010362_harmless_offering_cast (~2896 tok)
- `202605010362_harmless_offering.sql` — 202605010362_harmless_offering (~3121 tok)
- `202605010363_donate_choose_opponent.sql` — 202605010363_donate_choose_opponent (~17709 tok)
- `202605010364_collection_optimizer.sql` — Collection Optimizer module schema: co_card_printings/co_card_tags/co_collection_items/co_decks/co_deck_cards/co_imports/co_deck_analyses + co_card_oracle & co_card_availability views + RLS. Isolated in public via co_ prefix; reuses cards only via oracle_id. (~1600 tok)
- `202605010364_collection_optimizer.sql` — Collection-Aware Deck Optimizer — module schema (MVP). (~2753 tok)
- `202605010365_buy_candidates.sql` — Buy suggestions: find cards the player does NOT own that fill a deck's needs, (~534 tok)
- `202605010366_buy_ranking.sql` — Refine buy-candidate ranking. Two changes vs migration 365: (~498 tok)
- `202605010367_binder_name.sql` — Capture the ManaBox "Binder Name" so a player can physically locate a card (~188 tok)
- `202605010368_commander_anthem.sql` — Dancer's Chakrams "other commanders you control get +2/+2 and have lifelink": `commander_only` anthem predicate in card_layered_power/toughness + card_has_lifelink (commander, source-controller, exclude attached_to); register skips it while the Equipment is unattached. (~6777 tok)
- `202605010369_dualcast.sql` — Alisaie Dualcast "2nd spell each turn costs {2} less": adds game_session_players.turn_spells_cast counter (note_spell_cast via spell_cast watcher), resolve_count_amount 'spells_cast_this_turn', and an nth_spell predicate on reduced_mana_cost's static cost_reduction. (~8736 tok)
- `202605010370_controller_state.sql` — 202605010370_controller_state (~1544 tok)
- `202605010371_board_state.sql` — 202605010371_board_state (~958 tok)
- `202605010372_second_spell_trigger.sql` — Alphinaud Eukrasia "2nd spell each turn → draw": adds a `spell_number` filter to fire_watcher_triggers (spell_cast trigger fires only when spells_cast_this_turn==N, mig 369 counter). (~3809 tok)
- `tests/feature/dancers-chakrams.test.ts` — DC1-3: equipped host + other-commanders +2/+2 & lifelink; unequipped grants nothing; equipping a commander doesn't double-buff (the "other" exclusion). (~700 tok)

## supabase/migrations/ (200-215, 2026-06-10)


## tests/


## tests/feature/

- `blade-of-selves.test.ts` — Blade of Selves (mig 357). "Equipped creature has myriad." Built on the new (~598 tok)
- `board-state.test.ts` — mig 371 — get_board_state bundles the big-screen board view into one jsonb (~553 tok)
- `carmen.test.ts` — Carmen, Cruel Skymarcher (mig 341). Two new pieces: (~914 tok)
- `cast-watcher-self.test.ts` — Cast-watcher self-trigger (mig 325) — a "whenever you cast a creature spell" (~663 tok)
- `change-deck.test.ts` — Lobby "change deck" (mig 324) — clear_deck_from_session lets a player undo a (~744 tok)
- `choose-type-anthem.test.ts` — choose_creature_type → persistent anthem (mig 337). A "choose a creature type" (~998 tok)
- `clavileno.test.ts` — Clavileño, First of the Blessed (mig 344). "Whenever you attack, target (~1066 tok)
- `conjurers-closet.test.ts` — Conjurer's Closet (mig 351). "At the beginning of your end step, you may exile (~496 tok)
- `controller-state.test.ts` — mig 370 — get_controller_state bundles the whole controller view into one jsonb (~776 tok)
- `copy-token-cleanup.test.ts` — Copy-token end-step cleanup (mig 347). The copy_permanent action already makes (~842 tok)
- `dancers-chakrams.test.ts` — mig 368 — Dancer's Chakrams: "Equipped creature gets +2/+2, has lifelink and (~1411 tok)
- `deck-smoke.test.ts` — Deck smoke test: every curated script in docs/commander-decks/card-scripts.json (~2795 tok)
- `defender.test.ts` — Defender enforcement (mig 323) — "a creature with defender can't attack." (~549 tok)
- `delina.test.ts` — Delina, Wild Mage (mig 360). "Whenever Delina attacks, choose target creature you (~680 tok)
- `donate-and-mana-spell.test.ts` — Cast-planner round-2 fixes — two spells that were engine-supported in principle (~1084 tok)
- `draw-floor.test.ts` — Draw-floor fix (mig 334). The draw branch of apply_triggered_ability_effects (~767 tok)
- `dualcast.test.ts` — mig 369 — Alisaie Leveilleur, Dualcast: "The second spell you cast each turn (~1430 tok)
- `echoing-assault.test.ts` — Echoing Assault (mig 359). "Whenever you attack a player, choose target nontoken (~622 tok)
- `fear.test.ts` — Fear keyword (mig 338). Cover of Darkness: "As this enters, choose a creature (~1062 tok)
- `flameshadow.test.ts` — Flameshadow Conjuring (mig 352). "Whenever a nontoken creature you control (~737 tok)
- `harmless-offering.test.ts` — Harmless Offering (mig 353). "Target opponent gains control of target permanent (~380 tok)
- `helm-of-the-host.test.ts` — Helm of the Host (mig 350). "At the beginning of combat on your turn, create a (~537 tok)
- `jaxis.test.ts` — Jaxis, the Troublemaker (mig 349). Activated copy (reusing Orthion's path) where (~733 tok)
- `lifegain-event.test.ts` — you_gain_life triggered event (mig 336). Marauding Blight-Priest: "Whenever (~695 tok)
- `mayhem-devil.test.ts` — Mayhem Devil — already engine-supported once mig 341 added the (~528 tok)
- `mirage-phalanx.test.ts` — Mirage Phalanx (no migration — reuses copy_self + begin_combat + cleanup_at_end_ (~574 tok)
- `mirror-march.test.ts` — Mirror March (mig 354). "Whenever a nontoken creature you control enters, flip a (~797 tok)
- `myriad.test.ts` — Myriad (mig 355). "Whenever this attacks, for each opponent other than the (~826 tok)
- `optional-trigger-target.test.ts` — Optional ("up to one target …") triggered-ability targets (mig 326). A trigger (~675 tok)
- `orthion.test.ts` — Orthion, Hero of Lavabrink (mig 348). Copy a creature you control from an (~710 tok)
- `patriarchs-bidding.test.ts` — Patriarch's Bidding (mig 343). "Each player chooses a creature type. Each (~794 tok)
- `quick-wins.test.ts` — Quick-win re-scripts (no migration — reuse already-built engine features): (~867 tok)
- `reanimate.test.ts` — Reanimate / Animate Dead (mig 346). The reanimation is return_from_graveyard (~798 tok)
- `reflexive-may-program.test.ts` — Reflexive "when you do" via may + program (mig 339). Ruthless Lawbringer: (~1062 tok)
- `return-on-death.test.ts` — Return-on-death (mig 345). Feign Death / Not Dead After All / Supernatural (~819 tok)
- `saw-in-half.test.ts` — Saw in Half (mig 356). "Destroy target creature. If that creature dies this way, (~566 tok)
- `second-spell-trigger.test.ts` — mig 372 — Alphinaud's Eukrasia: "Whenever you cast your SECOND spell each turn, (~653 tok)
- `shared-animosity.test.ts` — Shared Animosity (mig 340). "Whenever a creature you control attacks, it gets (~953 tok)
- `shock-land.test.ts` — Shock lands (mig 327) — "enters tapped UNLESS you pay 2 life". Playing one puts (~854 tok)
- `sorin.test.ts` — Sorin, Imperious Bloodlord — quick-win re-script (no migration). Its +1 (~593 tok)
- `splinter-twin-cast.test.ts` — Splinter Twin — Aura-cast-attach verification. Confirms the FULL path (not the (~656 tok)
- `splinter-twin.test.ts` — Splinter Twin (mig 358). "Enchant creature. Enchanted creature has '{T}: create a (~578 tok)
- `tap-self.test.ts` — tap_self effect action (mig 335). "Tap it" taps the SOURCE permanent — the (~779 tok)
- `vampire-nocturnus.test.ts` — Vampire Nocturnus (mig 342). Conditional tribal anthem: "as long as the top (~851 tok)
- `xantcha.test.ts` — Xantcha, Sleeper Agent (mig 361). "Xantcha enters under the control of an (~654 tok)

## tests/fixtures/

- `test-cards.json` (~49121 tok)

## tests/harness/


## tests/regression/


## tests/unit/

- `ai-recommend.test.ts` — AI deck-doctor — the pure grounding helpers. The model call itself is not tested (~799 tok)
- `auto-pass.test.ts` — shouldAutoPass — the controller's pure "should I pass priority right now?" (~2653 tok)
- `bot-brain.test.ts` — bot-brain — the AI CPU's pure heuristic decisions (lib/game/bot-brain). Each (~2536 tok)
- `conflicts-buy.test.ts` — Deck conflicts (pure detection) + buy-suggestion link building. (~631 tok)
- `dashboard.test.ts` — Dashboard — pure "free staples" ranking (strong unused binder cards). (~517 tok)
- `decklist-parser.test.ts` — Decklist parser — the pure core of the deck import. Covers the quantity/set/ (~813 tok)
- `fetch-decklist.test.ts` — Deck-URL import — the pure URL detection + JSON→text mappers, plus the fetch (~1159 tok)
- `insights.test.ts` — Collection Insights — pure per-deck fit ranking. (~786 tok)
- `keyword-icons.test.ts` — normalizeKeywords — the pure mapper that turns a card's keyword strings into the (~510 tok)
- `manabox-parser.test.ts` — ManaBox CSV parser + oracle resolver — the pure core of the collection import. (~1374 tok)
- `power-score.test.ts` — Power score — deterministic deck rating from synergy buckets + curve. Builds (~804 tok)
- `registry-schema-drift.test.ts` — Drift guard for the card-behavior authoring stack's two type vocabularies: (~3222 tok)
- `scoring.test.ts` — Recommendation scoring — commander synergy, theme impact, curve fit, confidence. (~1108 tok)
- `synergy-tagger.test.ts` — Synergy tagger — heuristic role detection from oracle text. Uses real card (~1500 tok)
- `upgrade-scanner.test.ts` — Upgrade scanner — the pure selection core (free swaps/additions, occupied, (~1028 tok)

## vercel/


## vercel/app/


## vercel/components/


## vercel/components/mtg/


## vercel/components/ui/


## vercel/hooks/


## vercel/lib/


## vercel/lib/mtg/


## vercel/styles/

