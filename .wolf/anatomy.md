# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-06-07T11:31:14.278Z
> Files: 15 tracked | Anatomy hits: 0 | Misses: 0

## ./

- `next.config.ts` — Pin the workspace root to this project. A stray parent lockfile (~278 tok)
- `package.json` — Node.js package manifest (~912 tok)

## .claude/


## .claude/projects/c--Users-Jordy-dev-LeylineSync/memory/

- `project_roadmap.md` — LeylineSync — Combined Roadmap (as of 2026-06-04) (~9313 tok)

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

- `page.tsx` — Lazy-load each controller version so opening the page only compiles the ONE (~475 tok)

## app/decks/


## app/judge/[id]/


## app/protected/


## components/

- `CardCatalogPicker.tsx` — cardTypeFilters (~2628 tok)
- `DeckManager.tsx` — DeckManager (~8614 tok)

## components/board/


## components/controller/


## components/judge/


## components/layout/


## components/tutorial/


## components/ui/


## docs/


## docs/commander-decks/


## lib/


## lib/game/


## lib/supabase/


## public/


## scripts/


## supabase/


## supabase/functions/spawn-deck/


## supabase/migrations/

- `202605010147_creature_damage_shields.sql` — Phase 4 / F2.1d — CREATURE damage shields (the creature analogue of mig 125). (~3423 tok)
- `202605010148_combat_creature_shields.sql` — Phase 4 / F2.1e — route COMBAT creature damage through the prevention resolver. (~5302 tok)
- `202605010149_cda_pt_layer.sql` — Phase 4 / F2.2f — the LAYER resolver, sublayer 7a: CHARACTERISTIC-DEFINING P/T. (~2332 tok)

## tests/


## tests/feature/

- `cda-pt.test.ts` — Phase 4 / F2.2f — characteristic-defining P/T, layer 7a (mig 149). A CDA defines (~870 tok)
- `combat-shield.test.ts` — Phase 4 / F2.1e — creature shields in COMBAT (mig 148). resolve_combat_damage now (~1004 tok)
- `creature-shield.test.ts` — Phase 4 / F2.1d — creature damage shields (mig 147). The creature analogue of the (~1176 tok)

## tests/fixtures/

- `test-cards.json` (~6457 tok)

## tests/harness/

- `scenario.ts` — Create a session. Seat A is the creator + active player; B/C/D join in seat (~9126 tok)
- `seed.ts` — Seeds the `% Test` cards into public.cards for the local test DB. (~657 tok)

## tests/regression/


## tests/unit/


## vercel/


## vercel/app/


## vercel/components/


## vercel/components/mtg/


## vercel/components/ui/


## vercel/hooks/


## vercel/lib/


## vercel/lib/mtg/


## vercel/styles/

