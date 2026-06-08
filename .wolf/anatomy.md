# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-06-08T18:25:35.153Z
> Files: 88 tracked | Anatomy hits: 0 | Misses: 0

## ./

- `package.json` — Node.js package manifest (~1264 tok)

## .claude/


## .claude/projects/c--Users-Jordy-dev-LeylineSync/memory/

- `project_roadmap.md` — LeylineSync — Combined Roadmap (as of 2026-06-04) (~13536 tok)

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

- `CardBehaviorEditor.tsx` — EMPTY_SCRIPT_PLACEHOLDER (~4152 tok)
- `CardBehaviorForm.tsx` — inputClass (~9538 tok)
- `ControllerListV4.tsx` — Returns the single mana color to auto-produce when a card has exactly one simple tap ability. (~58607 tok)
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

- `actions.ts` — Exports getErrorMessage, setCardTapped, moveCardToZone, castCardFromHand + 24 more (~11645 tok)
- `card-behavior-builder.ts` — Guided card-behavior form model: a structured representation of the subset of (~8984 tok)
- `card-behavior-llm.ts` — LLM-facing description of the card behavior script format. (~11109 tok)
- `card-behavior-registry.ts` — Declarative registry of the form-editable card effects. ONE entry per effect (~10447 tok)
- `card-behavior-schema.ts` — ─── Shared primitives ─────────────────────────────────────────────────────── (~7685 tok)
- `card-behavior.ts` — Classify a catalog card's rules readiness for the deck editor: (~3523 tok)
- `data.ts` — Sums active until-end-of-turn pump effects per affected card id. Best-effort: returns {} on error. (~6002 tok)
- `types.ts` — Exports ManaPool, ManaColor, GameZone, GameSessionStatus + 29 more (~2478 tok)
- `use-judge-card-tools.ts` — Exports useJudgeCardTools (~1636 tok)

## lib/supabase/


## public/


## scripts/

- `import-scryfall-cards.mjs` — defaultInputFile: flushBatch, upsertBatchWithRetry, getSupabaseErrorMessage + 15 more (~3086 tok)

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
- `202605010168_planeswalkers.sql` — Planeswalkers — core framework (roadmap Tribal #4, slice 1). (~2363 tok)
- `202605010169_planeswalker_combat.sql` — Planeswalker combat (roadmap Tribal #4, slice 2). Attack a planeswalker; its (~6877 tok)
- `202605010170_choose_creature_type.sql` — Choose a creature type (roadmap Tribal #6). "Choose a creature type, then <effect>" (~9295 tok)
- `202605010171_conditional_mill.sql` — Conditional mill (for Liliana, Untouched by Death's +1 and graveyard-matters cards). (~3803 tok)
- `202605010172_dynamic_pump_loyalty_target.sql` — Dynamic / negatable pump + pump as a targetable effect (for Liliana, Untouched by (~2878 tok)
- `202605010173_cast_from_graveyard.sql` — Cast-from-graveyard permission (Liliana, Untouched by Death's -3: (~6119 tok)
- `202605010174_flashback_and_tapped_tokens.sql` — Army of the Damned: "Create thirteen 2/2 black Zombie creature tokens that are (~2083 tok)
- `202605010175_sacrifice_self_ability_cost.sql` — Reproduces activate_ability (from mig 162) adding the `sacrifice_self` activated-ability cost (Commander's Sphere). Sacrifices the source via put_in_graveyard after other costs, before the ability hits the stack. (~2448 tok)
- `202605010176_flashback_life_cost.sql` — Flashback with an additional "Pay N life" cost (Deep Analysis: "Flashback— (~2138 tok)
- `202605010177_flashback_alternate_effect.sql` — Flashback that does DIFFERENT/extra stuff than the hand cast (the "Increasing" (~2362 tok)
- `202605010178_exile_from_graveyard_cost.sql` — "Exile a creature card from a graveyard" as an activated-ability cost, plus (~3073 tok)
- `202605010179_mass_typed_debuff.sql` — Crippling Fear — "Choose a creature type. Each creature that isn't of the (~7295 tok)
- `202605010180_mana_ability_cost_multicolor.sql` — Mana abilities with an activation cost and/or multiple produced colours (~1153 tok)
- `202605010181_watcher_nontoken_filter.sql` — `nontoken` watcher filter — "Whenever a NONTOKEN creature you control dies, …" (~873 tok)
- `202605010182_amass.sql` — Amass N (War of the Spark) — "If you don't control an Army, create a 0/0 black (~4488 tok)
- `202605010183_sacrifice_creature_cost.sql` — "Sacrifice a creature" as an activated-ability cost (Spark Reaper: "{2}{B}, (~3399 tok)

## tests/


## tests/feature/

- `amass.test.ts` — Amass N (mig 182) — "If you don't control an Army, create a 0/0 black Zombie (~885 tok)
- `army-of-the-damned.test.ts` — Army of the Damned — "Create thirteen 2/2 black Zombie creature tokens that are (~1092 tok)
- `assassins-trophy.test.ts` — Assassin's Trophy (mig 152) — "Destroy target permanent an opponent controls. Its (~769 tok)
- `beast-within.test.ts` — Beast Within (card request) — "Destroy target permanent. Its controller creates a (~1132 tok)
- `cemetery-reaper.test.ts` — Cemetery Reaper's activated ability (mig 178): "{2}{B}, {T}, Exile a creature (~980 tok)
- `choose-creature-type.test.ts` — Choose a creature type (roadmap Tribal #6). A choose_creature_type effect parks a (~732 tok)
- `commander-identity-mana.test.ts` — Commander-identity mana (mig 151) — "Add one mana of any color in your commander's (~662 tok)
- `count-amounts.test.ts` — Count-based dynamic amounts (roadmap Tribal #2). An effect "amount" of (~968 tok)
- `counter-doubling.test.ts` — Counter doubling — Doubling Season (roadmap Counters #5, half 1). A static (~1248 tok)
- `counter-placement-trigger.test.ts` — Counter-placement trigger event (roadmap Tribal #3). `creature_got_counter` fires (~1243 tok)
- `counter-removal.test.ts` — Counter removal (roadmap Counters #1). Reuses the add_counters pipeline: a NEGATIVE (~1811 tok)
- `crippling-fear.test.ts` — Crippling Fear (mig 179) — "Choose a creature type. Each creature that isn't of (~943 tok)
- `dynamic-counter-amounts.test.ts` — State-referencing dynamic amounts (roadmap Counters #5 half 2 + #8 half 2). A (~1830 tok)
- `energy-cost.test.ts` — Energy as an activation cost (roadmap Counters #8, consumable half). An activated (~993 tok)
- `enters-with-counters.test.ts` — "Enters the battlefield with N counters" (roadmap Counters #3). A REPLACEMENT applied (~1031 tok)
- `flashback-alternate-effect.test.ts` — Flashback that does a DIFFERENT/extra effect than the hand cast (the (~842 tok)
- `flashback-life.test.ts` — Flashback with an additional "Pay N life" cost (mig 176). Deep Analysis's (~662 tok)
- `infect-toxic-wither.test.ts` — Infect / toxic / wither combat (roadmap Counters #7). Combat damage routed into the (~1760 tok)
- `liliana-untouched.test.ts` — Liliana, Untouched by Death — her +1 (conditional mill). "Mill three cards. If at (~1730 tok)
- `mana-ability-multicolor.test.ts` — Mana abilities with an activation cost + multiple produced colours (mig 180). (~582 tok)
- `minus-one-counters.test.ts` — −1/−1 counters (roadmap Counters #4). Stored as the bag key 'minus_one_one' (so (~1559 tok)
- `multi-counter.test.ts` — Multi-counter model (Tier 1 + poison loss). The engine kept plus_one_counters on (~1943 tok)
- `nontoken-watcher.test.ts` — `nontoken` watcher filter (mig 181) — "Whenever a NONTOKEN creature you control (~749 tok)
- `planeswalker-combat.test.ts` — Planeswalker combat (roadmap Tribal #4, slice 2). A creature can attack a planeswalker; (~960 tok)
- `planeswalkers.test.ts` — Planeswalkers — core framework (roadmap Tribal #4, slice 1). A planeswalker enters (~1298 tok)
- `proliferate.test.ts` — Proliferate (Atraxa, Praetors' Voice end step, Karn's Bastion, etc.). The engine (~1083 tok)
- `sacrifice-creature-cost.test.ts` — "Sacrifice a creature" activated-ability cost (mig 183). Spark Reaper (~862 tok)
- `sacrifice-self-ability.test.ts` — Sacrifice-self activated cost (Commander's Sphere, mig 175): source → graveyard as a cost, then draw resolves; can't re-activate. (~600 tok)
- `sacrifice-self-ability.test.ts` — Sacrifice-self as an activated-ability cost (mig 175). Commander's Sphere's (~639 tok)
- `target-player-draw.test.ts` — "Target player draws N" (Deep Analysis) = choose_player(any) → draw; the CHOSEN player draws, not the caster (can target self or opponent). (~700 tok)
- `targeted-spell-riders.test.ts` — Targeted spell riders + nonland_permanent target (mig 150) — Anguished Unmaking: (~1031 tok)
- `typed-lords.test.ts` — Typed lords / tribal anthems (roadmap Tribal #1, first slice). A `pump` continuous (~913 tok)
- `watcher-triggers.test.ts` — Other-scoped trigger events (roadmap Tribal #1, second half). `creature_entered` / (~1569 tok)

## tests/fixtures/

- `test-cards.json` (~10889 tok)

## tests/harness/

- `scenario.ts` — Create a session. Seat A is the creator + active player; B/C/D join in seat (~9754 tok)
- `seed.ts` — Seeds the `% Test` cards into public.cards for the local test DB. (~673 tok)

## tests/regression/


## tests/unit/

- `card-behavior-builder.test.ts` — Characterization tests for the guided-form ↔ script-JSON conversion in (~13358 tok)

## vercel/


## vercel/app/


## vercel/components/


## vercel/components/mtg/


## vercel/components/ui/


## vercel/hooks/


## vercel/lib/


## vercel/lib/mtg/


## vercel/styles/

