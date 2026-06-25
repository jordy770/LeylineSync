# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-06-25T07:08:54.216Z
> Files: 57 tracked | Anatomy hits: 0 | Misses: 0

## ../../.claude/plans/


## ../../.claude/projects/C--Users-Jordy-dev-LeylineSync/memory/

- `local-migrations.md` — Declares migrations (~422 tok)
- `MEMORY.md` (~191 tok)
- `opponent-view-design.md` (~1115 tok)

## ../../.cloudflared/

- `config.yml` — Cloudflare Tunnel ingress for the LeylineSync dev server. (~294 tok)

## ./

- `.gitignore` — Git ignore rules (~370 tok)

## .claude/


## .claude/projects/c--Users-Jordy-dev-LeylineSync/memory/


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

- `ControllerListV5.tsx` — The mana an untapped card auto-produces when it has exactly one simple (~69850 tok)
- `GameBoard.tsx` — GameBoard (~7302 tok)
- `GameLogPanel.tsx` — Shared self-contained game-log overlay (own supabase client + game_action_log realtime); used by GameBoard. Controller has its own GameLogSheet (~1215 tok)
- `GameSessionLobby.tsx` — GameSessionLobby (~12039 tok)

## components/board/

- `BoardViewChrome.tsx` — BoardViewChrome (~590 tok)
- `GameFinishedOverlay.tsx` — GameFinishedOverlay (~1180 tok)

## components/controller/


## components/judge/


## components/layout/


## components/tutorial/


## components/ui/


## docs/

- `backlog.md` — Backlog (~169 tok)

## docs/commander-decks/


## lib/


## lib/game/

- `actions.ts` — Exports getErrorMessage, setCardTapped, moveCardToZone, castCardFromHand + 25 more (~13002 tok)
- `auto-pass.ts` — You are the active (turn) player. (~1508 tok)
- `bot-brain.ts` — Pure AI-bot heuristics: mulligan, main-phase plays, and keyword-aware combat (decideAttacks/decideBlocks honour evasion/menace/trample/first-strike/deathtouch + defensive reserves). (~3013 tok)
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

- `bot-runner.mjs` — Plain read as the postgres session role (RLS bypassed) — used for polling. (~8207 tok)

## supabase/


## supabase/functions/spawn-deck/


## supabase/functions_src/

- `apply_trigger_effects.sql` — supabase/functions_src/apply_trigger_effects.sql (~20733 tok)
- `card_has_defender.sql` — supabase/functions_src/card_has_defender.sql (~563 tok)
- `choose_triggered_ability_creature_target.sql` — supabase/functions_src/choose_triggered_ability_creature_target.sql (~1105 tok)
- `clear_deck_from_session.sql` — supabase/functions_src/clear_deck_from_session.sql (~471 tok)
- `declare_attacker.sql` — supabase/functions_src/declare_attacker.sql (~3458 tok)
- `enqueue_triggered_ability.sql` — supabase/functions_src/enqueue_triggered_ability.sql (~1699 tok)
- `fire_watcher_triggers.sql` — supabase/functions_src/fire_watcher_triggers.sql (~3404 tok)
- `get_session_players.sql` — supabase/functions_src/get_session_players.sql (~464 tok)
- `get_stack_items.sql` — supabase/functions_src/get_stack_items.sql (~1080 tok)
- `get_turn_state.sql` — supabase/functions_src/get_turn_state.sql (~785 tok)
- `register_card_continuous_effects.sql` — supabase/functions_src/register_card_continuous_effects.sql (~2657 tok)
- `reset_mana.sql` — supabase/functions_src/reset_mana.sql (~512 tok)

## supabase/migrations/

- `202605010323_defender_keyword.sql` — 202605010323_defender_keyword (~6859 tok)
- `202605010324_clear_deck_from_session.sql` — 202605010324_clear_deck_from_session (~468 tok)
- `202605010325_cast_watcher_not_self.sql` — 202605010325_cast_watcher_not_self (~3475 tok)
- `202605010326_optional_trigger_targets.sql` — 202605010326_optional_trigger_targets (~23518 tok)
- `202605010326_stack_bot_username.sql` — 202605010326_stack_bot_username (~1517 tok)
- `202605010327_realtime_game_tables.sql` — 202605010327_realtime_game_tables (~302 tok)
- `202605010328_turn_state_bot_name.sql` — 202605010328_turn_state_bot_name (~850 tok)
- `202605010330_game_log.sql` — 202605010330_game_log (~784 tok)
- `202605010331_game_log_outcomes.sql` — 202605010331_game_log_outcomes (~876 tok)

## supabase/migrations/ (200-215, 2026-06-10)


## tests/


## tests/feature/

- `cast-watcher-self.test.ts` — Cast-watcher self-trigger (mig 325) — a "whenever you cast a creature spell" (~663 tok)
- `change-deck.test.ts` — Lobby "change deck" (mig 324) — clear_deck_from_session lets a player undo a (~744 tok)
- `defender.test.ts` — Defender enforcement (mig 323) — "a creature with defender can't attack." (~549 tok)
- `optional-trigger-target.test.ts` — Optional ("up to one target …") triggered-ability targets (mig 326). A trigger (~675 tok)

## tests/fixtures/

- `test-cards.json` (~43610 tok)

## tests/harness/


## tests/regression/


## tests/unit/

- `auto-pass.test.ts` — shouldAutoPass — the controller's pure "should I pass priority right now?" (~2653 tok)
- `bot-brain.test.ts` — bot-brain — the AI CPU's pure heuristic decisions (lib/game/bot-brain). Each (~2536 tok)

## vercel/


## vercel/app/


## vercel/components/


## vercel/components/mtg/


## vercel/components/ui/


## vercel/hooks/


## vercel/lib/


## vercel/lib/mtg/


## vercel/styles/

