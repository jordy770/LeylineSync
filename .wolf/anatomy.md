# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-06-05T11:56:08.901Z
> Files: 43 tracked | Anatomy hits: 0 | Misses: 0

## ./

- `package.json` — Node.js package manifest (~679 tok)
- `README.md` — Project documentation (~15932 tok)

## .claude/


## .claude/projects/c--Users-Jordy-dev-LeylineSync/memory/

- `project_roadmap.md` — LeylineSync — Combined Roadmap (as of 2026-06-04) (~3723 tok)

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

- `ControllerListV4.tsx` — Returns the single mana color to auto-produce when a card has exactly one simple tap ability. (~47914 tok)

## components/board/


## components/controller/


## components/judge/


## components/layout/


## components/tutorial/


## components/ui/


## docs/


## lib/


## lib/game/

- `actions.ts` — Exports getErrorMessage, setCardTapped, moveCardToZone, castCardFromHand + 24 more (~9863 tok)
- `card-behavior-builder.ts` — Guided card-behavior form model: a structured representation of the subset of (~5308 tok)
- `card-behavior-llm.ts` — LLM-facing description of the card behavior script format. (~5582 tok)
- `card-behavior-registry.ts` — Declarative registry of the form-editable card effects. ONE entry per effect (~6488 tok)
- `card-behavior-schema.ts` — ─── Shared primitives ─────────────────────────────────────────────────────── (~4492 tok)

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
- `202605010104_stack_action_handler_registry.sql` — Refactor: data-driven stack-action dispatch (behavior-preserving). (~4812 tok)
- `202605010105_put_action_builder_registry.sql` — Refactor part 2: data-driven cast-side dispatch for put_action_on_stack (~5043 tok)
- `202605010106_gain_control.sql` — Tier-2 effect: gain_control (Threaten / Mind Control) — TRIGGER path. (~3472 tok)
- `202605010107_gain_control_spell_and_threaten.sql` — gain_control follow-ups: (1) the "threaten" combat extras, (2) the SPELL path. (~3174 tok)
- `202605010108_sacrifice_and_reanimate.sql` — Phase 1, slice 11: two more resolution-time choices — sacrifice and (~7394 tok)
- `202605010109_x_spells.sql` — Phase 1, slice 12 — X spells (variable amounts paid as {X} generic mana). (~6323 tok)
- `202605010110_each_opponent_sacrifice.sql` — Phase 1, slice 13 — multi-opponent edict: sacrifice who:'each_opponent'. (~8136 tok)
- `202605010111_search_library_variants.sql` — Phase 1, slice 14 — search_library variants beyond the basic tutor. (~7783 tok)
- `202605010112_multi_creature_effect.sql` — Phase 3, slice 1 — general multi-target (removal family): destroy / exile / (~1593 tok)
- `202605010113_permanent_effect.sql` — Phase 3, slice 2 — targeting reach: NON-CREATURE PERMANENT targets. destroy / (~2078 tok)
- `202605010114_permanent_trigger_targets.sql` — Phase 3, slice 3 — trigger-side targeting reach: NON-CREATURE PERMANENT targets (~4087 tok)
- `202605010115_divided_damage.sql` — Phase 3, slice 4a — DIVIDED damage: "deal N damage divided as you choose among (~1740 tok)
- `202605010116_multi_target_triggers.sql` — Phase 3, slice 4b — MULTI-target triggered abilities. "When this enters, (~5619 tok)

## tests/


## tests/feature/

- `divided-damage.test.ts` — Phase 3, slice 4a — divided damage (mig 115): the `divided_damage` action type (~1279 tok)
- `fight.test.ts` — Tier-2 effect: fight (migration 101) — the first multi-target effect. A (~2640 tok)
- `gain-control.test.ts` — Tier-2 effect: gain_control (migration 106) — Threaten / Mind Control on the (~1860 tok)
- `grant-keyword-spell.test.ts` — Tier-2 effect: grant_keyword spell/combat-trick path (migration 100). A (~789 tok)
- `grant-keyword.test.ts` — Tier-2 effect: grant_keyword — a targeted trigger gives a creature a keyword (~696 tok)
- `multi-target-trigger.test.ts` — Phase 3, slice 4b — multi-target triggered abilities (mig 116). "When this (~1053 tok)
- `multi-target.test.ts` — Phase 3, slice 1 — general multi-target removal (mig 112): the (~1574 tok)
- `permanent-target.test.ts` — Phase 3, slice 2 — non-creature permanent targets (mig 113): the (~1370 tok)
- `permanent-trigger-target.test.ts` — Phase 3, slice 3 — non-creature permanent targets for TRIGGERED abilities (~1123 tok)
- `sacrifice-reanimate.test.ts` — Phase 1, slice 11 — sacrifice and return_from_graveyard (raise dead / (~2740 tok)
- `search-library-variants.test.ts` — Phase 1, slice 14 — search_library variants (mig 111): graveyard destination, (~1560 tok)
- `x-spells.test.ts` — Phase 1, slice 12 — X spells (variable amount paid as {X} generic mana). (~1339 tok)

## tests/fixtures/

- `test-cards.json` (~4682 tok)

## tests/harness/

- `scenario.ts` — Create a session. Seat A is the creator + active player; B (and C, when (~4996 tok)
- `seed.ts` — Seeds the `% Test` cards into public.cards for the local test DB. (~449 tok)

## tests/regression/


## tests/unit/

- `card-behavior-builder.test.ts` — Characterization tests for the guided-form ↔ script-JSON conversion in (~7876 tok)

## vercel/


## vercel/app/


## vercel/components/


## vercel/components/mtg/


## vercel/components/ui/


## vercel/hooks/


## vercel/lib/


## vercel/lib/mtg/


## vercel/styles/

