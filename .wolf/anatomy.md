# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-06-07T15:19:42.537Z
> Files: 23 tracked | Anatomy hits: 0 | Misses: 0

## ./

- `package.json` — Node.js package manifest (~954 tok)

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

- `CardBehaviorForm.tsx` — inputClass (~5895 tok)
- `ControllerListV4.tsx` — Returns the single mana color to auto-produce when a card has exactly one simple tap ability. (~54638 tok)

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

- `actions.ts` — Exports getErrorMessage, setCardTapped, moveCardToZone, castCardFromHand + 24 more (~10980 tok)
- `card-behavior-builder.ts` — Guided card-behavior form model: a structured representation of the subset of (~5434 tok)
- `card-behavior-llm.ts` — LLM-facing description of the card behavior script format. (~7390 tok)
- `card-behavior-registry.ts` — Declarative registry of the form-editable card effects. ONE entry per effect (~9508 tok)
- `card-behavior-schema.ts` — ─── Shared primitives ─────────────────────────────────────────────────────── (~5708 tok)
- `card-behavior.ts` — Classify a catalog card's rules readiness for the deck editor: (~3269 tok)
- `data.ts` — Sums active until-end-of-turn pump effects per affected card id. Best-effort: returns {} on error. (~6002 tok)
- `types.ts` — Exports ManaPool, ManaColor, GameZone, GameSessionStatus + 29 more (~2478 tok)

## lib/supabase/


## public/


## scripts/


## supabase/


## supabase/functions/spawn-deck/


## supabase/migrations/

- `202605010150_targeted_spell_riders.sql` — Targeted spell RIDERS + the `nonland_permanent` target type (Anguished Unmaking). (~1727 tok)
- `202605010151_commander_identity_mana.sql` — Commander-identity mana ("Add one mana of any color in your commander's color (~1357 tok)
- `202605010152_assassins_trophy_rider.sql` — Assassin's Trophy — "Destroy target permanent an opponent controls. Its controller (~2006 tok)
- `202605010153_proliferate.sql` — Proliferate (Atraxa, Praetors' Voice end step) — "Choose any number of permanents (~8315 tok)
- `202605010154_multi_counter_model.sql` — Multi-counter model (Tier 1 + poison loss). (~15283 tok)

## tests/


## tests/feature/

- `assassins-trophy.test.ts` — Assassin's Trophy (mig 152) — "Destroy target permanent an opponent controls. Its (~769 tok)
- `commander-identity-mana.test.ts` — Commander-identity mana (mig 151) — "Add one mana of any color in your commander's (~662 tok)
- `multi-counter.test.ts` — Multi-counter model (Tier 1 + poison loss). The engine kept plus_one_counters on (~1943 tok)
- `proliferate.test.ts` — Proliferate (Atraxa, Praetors' Voice end step, Karn's Bastion, etc.). The engine (~1083 tok)
- `targeted-spell-riders.test.ts` — Targeted spell riders + nonland_permanent target (mig 150) — Anguished Unmaking: (~1031 tok)

## tests/fixtures/


## tests/harness/

- `scenario.ts` — Create a session. Seat A is the creator + active player; B/C/D join in seat (~9330 tok)

## tests/regression/


## tests/unit/

- `card-behavior-builder.test.ts` — Characterization tests for the guided-form ↔ script-JSON conversion in (~9410 tok)

## vercel/


## vercel/app/


## vercel/components/


## vercel/components/mtg/


## vercel/components/ui/


## vercel/hooks/


## vercel/lib/


## vercel/lib/mtg/


## vercel/styles/

