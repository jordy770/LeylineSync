# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-06-07T22:29:07.525Z
> Files: 54 tracked | Anatomy hits: 0 | Misses: 0

## ./

- `package.json` — Node.js package manifest (~1090 tok)

## .claude/


## .claude/projects/c--Users-Jordy-dev-LeylineSync/memory/

- `project_roadmap.md` — LeylineSync — Combined Roadmap (as of 2026-06-04) (~12432 tok)

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
- `ControllerListV4.tsx` — Returns the single mana color to auto-produce when a card has exactly one simple tap ability. (~54974 tok)
- `JudgePanel.tsx` — JudgePanel (~1516 tok)

## components/board/


## components/controller/


## components/judge/

- `JudgePlayerCardTools.tsx` — Player counters a judge can dial in (poison gates the game at 10). (~3979 tok)

## components/layout/


## components/tutorial/


## components/ui/


## docs/


## docs/commander-decks/


## lib/


## lib/game/

- `actions.ts` — Exports getErrorMessage, setCardTapped, moveCardToZone, castCardFromHand + 24 more (~11325 tok)
- `card-behavior-builder.ts` — Guided card-behavior form model: a structured representation of the subset of (~5525 tok)
- `card-behavior-llm.ts` — LLM-facing description of the card behavior script format. (~9325 tok)
- `card-behavior-registry.ts` — Declarative registry of the form-editable card effects. ONE entry per effect (~9737 tok)
- `card-behavior-schema.ts` — ─── Shared primitives ─────────────────────────────────────────────────────── (~6456 tok)
- `card-behavior.ts` — Classify a catalog card's rules readiness for the deck editor: (~3296 tok)
- `data.ts` — Sums active until-end-of-turn pump effects per affected card id. Best-effort: returns {} on error. (~6002 tok)
- `types.ts` — Exports ManaPool, ManaColor, GameZone, GameSessionStatus + 29 more (~2478 tok)
- `use-judge-card-tools.ts` — Exports useJudgeCardTools (~1636 tok)

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
- `202605010155_counter_removal.sql` — Counter removal authoring (roadmap Counters #1). (~6615 tok)
- `202605010156_enters_with_counters.sql` — "Enters the battlefield with N counters" (roadmap Counters #3). (~710 tok)
- `202605010157_minus_one_counters.sql` — −1/−1 counters (roadmap Counters #4, the Tier-2 P/T-touching item). (~7514 tok)
- `202605010158_counter_doubling.sql` — Counter doubling — Doubling Season / Corpsejack Menace (roadmap Counters #5, half 1). (~6801 tok)
- `202605010159_infect_toxic_wither.sql` — Infect / toxic / wither combat (roadmap Counters #7). (~9278 tok)
- `202605010160_energy_cost.sql` — Energy as an activation cost (roadmap Counters #8, the consumable half). (~2431 tok)
- `202605010161_dynamic_counter_amounts.sql` — State-referencing dynamic amounts (roadmap Counters #5 half 2 + #8 half 2, unified). (~4488 tok)
- `202605010162_dynamic_amounts_spells_abilities.sql` — Dynamic amounts on the SPELL + ACTIVATED-ABILITY surfaces (roadmap Counters #5b/#8b (~6624 tok)
- `202605010163_beast_within.sql` — Beast Within — "Destroy target permanent. Its controller creates a 3/3 green Beast (~1973 tok)
- `202605010164_typed_lords.sql` — Typed lords / tribal anthems (roadmap Tribal #1, first slice). (~1738 tok)
- `202605010165_watcher_triggers.sql` — Other-scoped trigger events (roadmap Tribal #1, second half). (~1707 tok)
- `202605010166_count_dynamic_amounts.sql` — Count-based dynamic amounts (roadmap Tribal #2). "X = number of creatures you (~1734 tok)
- `202605010167_counter_placement_trigger.sql` — Counter-placement trigger event (roadmap Tribal #3). "Whenever ~ / a creature you (~466 tok)

## tests/


## tests/feature/

- `assassins-trophy.test.ts` — Assassin's Trophy (mig 152) — "Destroy target permanent an opponent controls. Its (~769 tok)
- `beast-within.test.ts` — Beast Within (card request) — "Destroy target permanent. Its controller creates a (~1132 tok)
- `commander-identity-mana.test.ts` — Commander-identity mana (mig 151) — "Add one mana of any color in your commander's (~662 tok)
- `count-amounts.test.ts` — Count-based dynamic amounts (roadmap Tribal #2). An effect "amount" of (~968 tok)
- `counter-doubling.test.ts` — Counter doubling — Doubling Season (roadmap Counters #5, half 1). A static (~1248 tok)
- `counter-placement-trigger.test.ts` — Counter-placement trigger event (roadmap Tribal #3). `creature_got_counter` fires (~1243 tok)
- `counter-removal.test.ts` — Counter removal (roadmap Counters #1). Reuses the add_counters pipeline: a NEGATIVE (~1811 tok)
- `dynamic-counter-amounts.test.ts` — State-referencing dynamic amounts (roadmap Counters #5 half 2 + #8 half 2). A (~1830 tok)
- `energy-cost.test.ts` — Energy as an activation cost (roadmap Counters #8, consumable half). An activated (~993 tok)
- `enters-with-counters.test.ts` — "Enters the battlefield with N counters" (roadmap Counters #3). A REPLACEMENT applied (~1031 tok)
- `infect-toxic-wither.test.ts` — Infect / toxic / wither combat (roadmap Counters #7). Combat damage routed into the (~1760 tok)
- `minus-one-counters.test.ts` — −1/−1 counters (roadmap Counters #4). Stored as the bag key 'minus_one_one' (so (~1559 tok)
- `multi-counter.test.ts` — Multi-counter model (Tier 1 + poison loss). The engine kept plus_one_counters on (~1943 tok)
- `proliferate.test.ts` — Proliferate (Atraxa, Praetors' Voice end step, Karn's Bastion, etc.). The engine (~1083 tok)
- `targeted-spell-riders.test.ts` — Targeted spell riders + nonland_permanent target (mig 150) — Anguished Unmaking: (~1031 tok)
- `typed-lords.test.ts` — Typed lords / tribal anthems (roadmap Tribal #1, first slice). A `pump` continuous (~913 tok)
- `watcher-triggers.test.ts` — Other-scoped trigger events (roadmap Tribal #1, second half). `creature_entered` / (~1569 tok)

## tests/fixtures/

- `test-cards.json` (~8809 tok)

## tests/harness/

- `scenario.ts` — Create a session. Seat A is the creator + active player; B/C/D join in seat (~9353 tok)
- `seed.ts` — Seeds the `% Test` cards into public.cards for the local test DB. (~673 tok)

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

