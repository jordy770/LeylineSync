# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-06-18T12:31:54.278Z
> Files: 22 tracked | Anatomy hits: 0 | Misses: 0

## ../../.claude/plans/


## ../../.claude/projects/C--Users-Jordy-dev-LeylineSync/memory/


## ../../.cloudflared/


## ./

- `package.json` — Node.js package manifest (~531 tok)

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

- `ControllerListV5.tsx` — The mana an untapped card auto-produces when it has exactly one simple (~56252 tok)

## components/board/


## components/controller/

- `CardActionSheet.tsx` — CardActionSheet (~19181 tok)
- `shared.ts` — Collects displayable keywords for a card from Scryfall keywords + scripted continuous effects. (~9950 tok)

## components/judge/


## components/layout/


## components/tutorial/


## components/ui/


## docs/

- `backlog.md` — Backlog (~160 tok)

## docs/commander-decks/


## lib/


## lib/game/

- `bot-brain.ts` — Raw type line, e.g. "Creature — Goblin" or "Basic Land — Mountain". (~1791 tok)
- `data.ts` — Exports emptyManaPool, gameZones, gameSessionStatuses, turnPhases + 11 more (~8194 tok)
- `types.ts` — Exports ManaPool, RestrictedManaEntry, ManaColor, GameZone + 30 more (~2991 tok)
- `use-controller-game-state.ts` — Exports useControllerGameState (~2587 tok)

## lib/supabase/


## mockups/


## public/


## scripts/

- `bot-runner.mjs` — Plain read as the postgres session role (RLS bypassed) — used for polling. (~5912 tok)
- `import-scryfall-cards.mjs` — defaultInputFile: flushBatch, upsertBatchWithRetry, getSupabaseErrorMessage + 16 more (~3514 tok)
- `seed-local-play.mjs` — Make the LOCAL play database (the `postgres` DB the Supabase API/app uses on (~644 tok)
- `setup-local-test-db.mjs` — Rebuilds the LOCAL test-harness database from scratch. (~1740 tok)

## supabase/


## supabase/functions/spawn-deck/


## supabase/functions_src/

- `cast_spell_effect.sql` — supabase/functions_src/cast_spell_effect.sql (~3243 tok)
- `get_stack_items.sql` — supabase/functions_src/get_stack_items.sql (~748 tok)
- `put_action_on_stack.sql` — supabase/functions_src/put_action_on_stack.sql (~2812 tok)

## supabase/migrations/

- `202605010321_cast_from_exile.sql` — 202605010321_cast_from_exile (~6096 tok)
- `202605010322_stack_item_image.sql` — 202605010322_stack_item_image (~691 tok)

## supabase/migrations/ (200-215, 2026-06-10)


## tests/


## tests/feature/

- `_repro_trade.test.ts` — Declares s (~404 tok)
- `atsushi.test.ts` — Atsushi, the Blazing Sky (mig 230) — a MODAL dies trigger ("choose one"): (~2066 tok)

## tests/fixtures/


## tests/harness/

- `db.ts` — Run `fn` inside a transaction and ALWAYS roll back, so a test leaves no trace. (~1105 tok)

## tests/regression/


## tests/unit/

- `bot-brain.test.ts` — bot-brain — the AI CPU's pure heuristic decisions (lib/game/bot-brain). Each (~1495 tok)

## vercel/


## vercel/app/


## vercel/components/


## vercel/components/mtg/


## vercel/components/ui/


## vercel/hooks/


## vercel/lib/


## vercel/lib/mtg/


## vercel/styles/

