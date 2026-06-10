# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-06-10T13:15:39.914Z
> Files: 35 tracked | Anatomy hits: 0 | Misses: 0

## ./


## .claude/


## .claude/projects/c--Users-Jordy-dev-LeylineSync/memory/


## .claude/rules/


## .git/


## Phase 1 Tier-B scry (added 2026-06-02)


## app/


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


## app/protected/


## components/

- `ControllerListV4.tsx` — Returns the single mana color to auto-produce when a card has exactly one simple tap ability. (~35314 tok)
- `GameSessionLobby.tsx` — GameSessionLobby (~4560 tok)

## components/board/


## components/controller/

- `CardActionSheet.tsx` — Bottom-sheet card action UI (cast, flashback, equip, target pickers, mana/loyalty abilities) + private CardZoomOverlay. Extracted verbatim from ControllerListV4. (~8700 tok)
- `CardDisplay.tsx` — Small display atoms: ManaSymbol, KeywordBadges, ManaCostDisplay, ManaPoolDisplay. (~660 tok)
- `OpeningHandOverlay.tsx` — Full-screen opening-hand overlay (London mulligan): keep/mulligan buttons, bottom-card selection chips, waiting-for-others variant. Rendered by ControllerListV4 while any player has opening_hand_kept === false. (~1249 tok)
- `shared.ts` — Pure helpers/constants extracted from ControllerListV4: SpellPlan + getSpellPlan, canCastHandSpell, targeting/protection filters, ability cost/effect renderers, mana colour constants. No JSX. (~3600 tok)

## components/judge/


## components/layout/


## components/tutorial/


## components/ui/


## docs/


## docs/commander-decks/

- `card-scripts.json` (~1241 tok)
- `next-deck.txt` — PASTE YOUR NEXT DECKLIST BELOW, then run:  npm run deck:triage (~164 tok)

## lib/


## lib/game/

- `actions.ts` — Exports getErrorMessage, setCardTapped, moveCardToZone, castCardFromHand + 24 more (~12003 tok)
- `card-behavior-schema.ts` — ─── Shared primitives ─────────────────────────────────────────────────────── (~10524 tok)
- `card-behavior.ts` — Classify a catalog card's rules readiness for the deck editor: (~3968 tok)

## lib/supabase/


## public/


## scripts/

- `setup-local-test-db.mjs` — Rebuilds the LOCAL test-harness database from scratch. (~912 tok)
- `triage-decklist.mjs` — Decklist triage — the planning step before implementing a deck's cards. (~3016 tok)
- `upsert-deck-scripts.mjs` — Upsert a decklist's behavior scripts onto the HOSTED card catalog (~2117 tok)
- `validate-fixtures-offline.mts` — Offline fixture validation — no DB, no credentials (unlike validate:scripts, (~332 tok)

## supabase/


## supabase/functions/spawn-deck/


## supabase/functions_src/

- `advance_step.sql` — supabase/functions_src/advance_step.sql (~2217 tok)
- `apply_trigger_effects.sql` — supabase/functions_src/apply_trigger_effects.sql (~5648 tok)
- `build_stack_payload_permanent_simple.sql` — supabase/functions_src/build_stack_payload_permanent_simple.sql (~670 tok)
- `cast_card_from_hand.sql` — supabase/functions_src/cast_card_from_hand.sql (~4066 tok)
- `get_session_players.sql` — supabase/functions_src/get_session_players.sql (~406 tok)
- `handle_permanent_effect.sql` — supabase/functions_src/handle_permanent_effect.sql (~1834 tok)
- `keep_opening_hand.sql` — supabase/functions_src/keep_opening_hand.sql (~643 tok)
- `mulligan_hand.sql` — supabase/functions_src/mulligan_hand.sql (~681 tok)
- `put_in_graveyard.sql` — supabase/functions_src/put_in_graveyard.sql (~937 tok)
- `resolve_count_amount.sql` — supabase/functions_src/resolve_count_amount.sql (~1136 tok)
- `start_game_session.sql` — supabase/functions_src/start_game_session.sql (~1078 tok)
- `submit_decision.sql` — supabase/functions_src/submit_decision.sql (~6133 tok)

## supabase/migrations/

- `202605010216_hot_path_indexes.sql` — Hot-path indexes (perf, no behavior change). (~299 tok)

## supabase/migrations/ (200-215, 2026-06-10)


## tests/


## tests/feature/

- `cruel-revival.test.ts` — Cruel Revival (mig 220) — "Destroy target non-Zombie creature. Return up to (~964 tok)
- `enters-tapped-lands.test.ts` — Enters-tapped lands (mig 217) — top-level `enters_tapped` read in (~1071 tok)
- `fleshbag-overseer.test.ts` — Free compositions for the Gisa deck's last two creatures — no engine change, (~1286 tok)
- `game-start.test.ts` — Game start sequence (mig 221) — random first player, 7-card opening hands, (~1843 tok)
- `undying.test.ts` — Undying (mig 219) — "When this creature dies, if it had no +1/+1 counters on (~820 tok)
- `victimize.test.ts` — Victimize (mig 218) — "Choose two target creature cards in your graveyard. (~849 tok)

## tests/fixtures/


## tests/harness/


## tests/regression/


## tests/unit/

- `card-config-status.test.ts` — getCardConfigStatus — the deck editor's "scripted / vanilla / needs behaviour" (~891 tok)

## vercel/


## vercel/app/


## vercel/components/


## vercel/components/mtg/


## vercel/components/ui/


## vercel/hooks/


## vercel/lib/


## vercel/lib/mtg/


## vercel/styles/

