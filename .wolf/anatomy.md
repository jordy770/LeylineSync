# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-06-23T21:57:49.146Z
> Files: 26 tracked | Anatomy hits: 0 | Misses: 0

## ../../.claude/plans/


## ../../.claude/projects/C--Users-Jordy-dev-LeylineSync/memory/


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

- `ControllerListV5.tsx` — The mana an untapped card auto-produces when it has exactly one simple (~57124 tok)
- `GameBoard.tsx` — GameBoard (~7231 tok)
- `GameSessionLobby.tsx` — GameSessionLobby (~12039 tok)

## components/board/

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

- `actions.ts` — Exports getErrorMessage, setCardTapped, moveCardToZone, castCardFromHand + 25 more (~12920 tok)
- `auto-pass.ts` — You are the active (turn) player. (~1362 tok)
- `bot-brain.ts` — Pure AI-bot heuristics: mulligan, main-phase plays, and keyword-aware combat (decideAttacks/decideBlocks honour evasion/menace/trample/first-strike/deathtouch + defensive reserves). (~3013 tok)
- `data.ts` — Exports emptyManaPool, gameZones, gameSessionStatuses, turnPhases + 11 more (~8383 tok)
- `use-board-game-state.ts` — Exports useBoardGameState (~1407 tok)
- `use-controller-game-state.ts` — Exports useControllerGameState (~2632 tok)

## lib/supabase/

- `client.ts` — Exports createClient (~66 tok)

## mockups/


## public/


## scripts/

- `bot-runner.mjs` — Plain read as the postgres session role (RLS bypassed) — used for polling. (~6322 tok)

## supabase/


## supabase/functions/spawn-deck/


## supabase/functions_src/

- `card_has_defender.sql` — supabase/functions_src/card_has_defender.sql (~563 tok)
- `clear_deck_from_session.sql` — supabase/functions_src/clear_deck_from_session.sql (~471 tok)
- `declare_attacker.sql` — supabase/functions_src/declare_attacker.sql (~3458 tok)
- `register_card_continuous_effects.sql` — supabase/functions_src/register_card_continuous_effects.sql (~2657 tok)

## supabase/migrations/

- `202605010323_defender_keyword.sql` — 202605010323_defender_keyword (~6859 tok)
- `202605010324_clear_deck_from_session.sql` — 202605010324_clear_deck_from_session (~468 tok)

## supabase/migrations/ (200-215, 2026-06-10)


## tests/


## tests/feature/

- `change-deck.test.ts` — Lobby "change deck" (mig 324) — clear_deck_from_session lets a player undo a (~744 tok)
- `defender.test.ts` — Defender enforcement (mig 323) — "a creature with defender can't attack." (~549 tok)

## tests/fixtures/

- `test-cards.json` (~43362 tok)

## tests/harness/


## tests/regression/


## tests/unit/

- `auto-pass.test.ts` — shouldAutoPass — the controller's pure "should I pass priority right now?" (~2284 tok)
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

