# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-06-04T21:54:39.922Z
> Files: 20 tracked | Anatomy hits: 0 | Misses: 0

## ./

- `package.json` — Node.js package manifest (~578 tok)
- `README.md` — Project documentation (~15932 tok)

## .claude/


## .claude/projects/c--Users-Jordy-dev-LeylineSync/memory/

- `project_roadmap.md` — LeylineSync — Combined Roadmap (as of 2026-06-04) (~2021 tok)

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

- `ControllerListV4.tsx` — Returns the single mana color to auto-produce when a card has exactly one simple tap ability. (~42155 tok)

## components/board/


## components/controller/


## components/judge/


## components/layout/


## components/tutorial/


## components/ui/


## docs/


## lib/


## lib/game/

- `actions.ts` — Exports getErrorMessage, setCardTapped, moveCardToZone, castCardFromHand + 24 more (~8346 tok)
- `card-behavior-builder.ts` — Guided card-behavior form model: a structured representation of the subset of (~5272 tok)
- `card-behavior-llm.ts` — LLM-facing description of the card behavior script format. (~4146 tok)
- `card-behavior-registry.ts` — Declarative registry of the form-editable card effects. ONE entry per effect (~6147 tok)
- `card-behavior-schema.ts` — ─── Shared primitives ─────────────────────────────────────────────────────── (~3792 tok)

## lib/supabase/


## public/


## scripts/


## supabase/


## supabase/functions/spawn-deck/


## supabase/migrations/

- `202605010099_grant_keyword.sql` — Tier-2 effect: grant_keyword — give a target creature a keyword until end of (~2051 tok)
- `202605010100_grant_keyword_spell.sql` — Tier-2 effect: grant_keyword spell/combat-trick path. (~5898 tok)
- `202605010101_fight.sql` — Tier-2 effect: fight (the first MULTI-target effect). (~4739 tok)
- `202605010102_fight_trigger.sql` — Tier-2 effect: fight — TRIGGER path ("when this enters, it fights target (~1435 tok)
- `202605010103_fight_deathtouch_and_mana.sql` — fight follow-ups: (1) deathtouch interaction, (2) generic-mana cost parity. (~3701 tok)

## tests/


## tests/feature/

- `fight.test.ts` — Tier-2 effect: fight (migration 101) — the first multi-target effect. A (~2640 tok)
- `grant-keyword-spell.test.ts` — Tier-2 effect: grant_keyword spell/combat-trick path (migration 100). A (~789 tok)
- `grant-keyword.test.ts` — Tier-2 effect: grant_keyword — a targeted trigger gives a creature a keyword (~696 tok)

## tests/fixtures/

- `test-cards.json` (~4042 tok)

## tests/harness/

- `scenario.ts` — Create a 2-player session. Seat A is the creator + active player. (~4400 tok)

## tests/regression/


## tests/unit/

- `card-behavior-builder.test.ts` — Characterization tests for the guided-form ↔ script-JSON conversion in (~7698 tok)

## vercel/


## vercel/app/


## vercel/components/


## vercel/components/mtg/


## vercel/components/ui/


## vercel/hooks/


## vercel/lib/


## vercel/lib/mtg/


## vercel/styles/

