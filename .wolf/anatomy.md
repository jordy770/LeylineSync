# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-06-06T20:41:25.660Z
> Files: 107 tracked | Anatomy hits: 0 | Misses: 0

## ./

- `next.config.ts` — Pin the workspace root to this project. A stray parent lockfile (~197 tok)
- `package.json` — Node.js package manifest (~873 tok)
- `README.md` — Project documentation (~16065 tok)

## .claude/


## .claude/projects/c--Users-Jordy-dev-LeylineSync/memory/

- `project_roadmap.md` — LeylineSync — Combined Roadmap (as of 2026-06-04) (~8877 tok)

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

- `page.tsx` — CardBehaviorPage (~448 tok)

## app/controller-style-lab/


## app/controller/[id]/


## app/decks/


## app/judge/[id]/


## app/protected/


## components/

- `CardBehaviorEditor.tsx` — EMPTY_SCRIPT_PLACEHOLDER (~4087 tok)
- `CardBehaviorForm.tsx` — inputClass (~5786 tok)
- `ControllerListV4.tsx` — Returns the single mana color to auto-produce when a card has exactly one simple tap ability. (~53454 tok)
- `DeckInsights.tsx` — COLOR_DOT (~1885 tok)
- `DeckManager.tsx` — DeckManager (~8188 tok)
- `GameSessionLobby.tsx` — GameSessionLobby (~4520 tok)

## components/board/


## components/controller/


## components/judge/


## components/layout/


## components/tutorial/


## components/ui/


## docs/


## docs/commander-decks/

- `atraxa-counters.txt` — Atraxa, Praetors' Voice — WUBG +1/+1 counters / proliferate (100 cards) (~406 tok)
- `krenko-goblins.txt` — Krenko, Mob Boss — mono-red goblin aggro (100 cards) (~355 tok)
- `README.md` — Project documentation (~302 tok)

## lib/


## lib/game/

- `actions.ts` — Exports getErrorMessage, setCardTapped, moveCardToZone, castCardFromHand + 24 more (~10861 tok)
- `card-behavior-builder.ts` — Guided card-behavior form model: a structured representation of the subset of (~5317 tok)
- `card-behavior-llm.ts` — LLM-facing description of the card behavior script format. (~6727 tok)
- `card-behavior-registry.ts` — Declarative registry of the form-editable card effects. ONE entry per effect (~7593 tok)
- `card-behavior-schema.ts` — ─── Shared primitives ─────────────────────────────────────────────────────── (~5075 tok)
- `card-behavior.ts` — Classify a catalog card's rules readiness for the deck editor: (~3237 tok)
- `data.ts` — Sums active until-end-of-turn pump effects per affected card id. Best-effort: returns {} on error. (~5941 tok)
- `deck-insights.ts` — Mana value (converted mana cost) of a mana cost string like "{2}{W}{U}". (~2139 tok)
- `types.ts` — Exports ManaPool, ManaColor, GameZone, GameSessionStatus + 29 more (~2386 tok)
- `use-controller-game-state.ts` — Exports useControllerGameState (~2048 tok)

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
- `202605010117_modal_spell_source_cost.sql` — Near-term authoring — make modal spells PLAYABLE from a hand card. The engine (~1482 tok)
- `202605010118_player_targeted_discard.sql` — Near-term authoring — player-targeted DISCARD (chosen vs random). Until now (~3648 tok)
- `202605010119_activated_ability_effects.sql` — Phase 4 — activated abilities beyond deal_damage. "{cost}: effect" abilities can (~2211 tok)
- `202605010120_cant_be_countered.sql` — "Can't be countered": a static spell property authored as a top-level (~799 tok)
- `202605010121_hybrid_phyrexian_mana.sql` — Phase 4 — richer mana model: HYBRID and PHYREXIAN symbols. (X already shipped, (~2950 tok)
- `202605010122_combat_over_assignment.sql` — Phase 4 — player-chosen combat damage OVER-ASSIGNMENT. (~4665 tok)
- `202605010123_apnap_trigger_ordering.sql` — Phase 4 / F1 — APNAP ordering of SIMULTANEOUS triggered abilities (CR 603.3b). (~2526 tok)
- `202605010124_reset_priority_round_on_stack_change.sql` — Phase 4 / F1b — restart the priority round when a new object enters the stack. (~548 tok)
- `202605010125_damage_prevention_resolver.sql` — Phase 4 / F2.1a — DAMAGE PREVENTION: the first replacement-effect resolver. (~2040 tok)
- `202605010126_prevent_damage_effect.sql` — Phase 4 / F2.1b — the `prevent_damage` card effect: real spells/abilities now (~3687 tok)
- `202605010127_combat_damage_through_resolver.sql` — Phase 4 / F2.1c — route COMBAT damage to players through the prevention resolver. (~4455 tok)
- `202605010128_set_pt_layer.sql` — Phase 4 / F2.2a — the LAYER resolver, slice 1: SET power/toughness (CR 613 7b). (~1753 tok)
- `202605010129_set_pt_creature_spell.sql` — Phase 4 / F2.2b — "becomes X/Y until end of turn": a targeted set_pt creature (~3010 tok)
- `202605010130_set_pt_trigger_path.sql` — Phase 4 / F2.2c — set_pt on the TRIGGER path ("when ~ enters, target creature (~423 tok)
- `202605010131_protection_color_and_targeting.sql` — F3 — Protection (DEBT), slice 1: colour model + the "can't be Targeted" (T) gate. (~5652 tok)
- `202605010132_protection_combat_damage.sql` — F3 — Protection (DEBT), slice 2: the "can't be Damaged" (D) gate for COMBAT. (~4982 tok)
- `202605010133_protection_cant_be_blocked.sql` — F3 — Protection (DEBT), slice 3: the "can't be Blocked" (B) gate. (~1362 tok)
- `202605010134_auras_and_attachment.sql` — F3 — Protection (DEBT), slice 4a: AURAS + the attachment substrate (the basis (~5838 tok)
- `202605010135_equipment_and_equip.sql` — F3 — Protection (DEBT), slice 4b: EQUIPMENT + the equip ability. (~1296 tok)
- `202605010136_commander_command_zone.sql` — Commander (EDH), slice 1 — the IN-GAME command zone mechanics. (~2591 tok)
- `202605010137_commander_format_and_damage.sql` — Commander (EDH), slice 2 — format-aware game start + COMMANDER DAMAGE. (~2185 tok)
- `202605010138_commander_deck_seeding.sql` — Commander (EDH), slice 3 — the DECK side: designate a commander on a deck and (~1316 tok)
- `202605010139_import_captures_commander.sql` — Commander (EDH) — importer auto-captures the Commander. (~1266 tok)
- `202605010140_skip_eliminated_players.sql` — Commander (EDH) / multiplayer — skip ELIMINATED players in the turn + priority (~3412 tok)
- `202605010141_commander_deck_legality.sql` — Commander (EDH) — SERVER-SIDE deck legality enforcement. (~2302 tok)
- `202605010142_commander_return_refinements.sql` — Commander (EDH) — return-to-command refinements. (~1696 tok)
- `202605010143_rls_scope_reads_to_session.sql` — Operational / security — scope game-state reads to SESSION MEMBERS. (~688 tok)
- `202605010144_cleanup_finished_session.sql` — Operational — explicit cleanup of a FINISHED game's runtime data. (~724 tok)
- `202605010145_anthem_static_pumps.sql` — Phase 4 / F2.2d — ANTHEMS: static, source-gated team pumps (CR 613 layer 7d). (~1663 tok)

## tests/


## tests/feature/

- `activated-abilities.test.ts` — Phase 4 — activated abilities beyond deal_damage (mig 119). "{cost}: effect" (~1012 tok)
- `anthem.test.ts` — Phase 4 / F2.2d — anthems: static team pumps (mig 145). A `pump` continuous effect (~1013 tok)
- `apnap-trigger-order.test.ts` — Phase 4 / F1 — APNAP ordering of simultaneous triggered abilities (mig 123). (~1112 tok)
- `auras.test.ts` — F3 slice 4a — Auras + attachment (mig 134). An Aura is cast targeting a creature, (~1715 tok)
- `cant-be-countered.test.ts` — "Can't be countered": a counter that targets an uncounterable spell resolves (~644 tok)
- `cleanup.test.ts` — Operational — cleanup_finished_session (mig 144) deletes a finished game's runtime (~567 tok)
- `combat-over-assignment.test.ts` — Phase 4 — player-chosen combat damage OVER-ASSIGNMENT (mig 122). The attacker (~1582 tok)
- `commander-deck.test.ts` — Commander (EDH) slice 3 — the deck side (mig 138). A deck can designate a (~2341 tok)
- `commander-return.test.ts` — Commander (EDH) — return-to-command refinements (mig 142). A commander leaving (~1132 tok)
- `commander.test.ts` — Commander (EDH) slice 1 — the in-game command zone (mig 136). A commander is (~1873 tok)
- `damage-prevention.test.ts` — Phase 4 / F2.1a — damage prevention resolver (mig 125). A shield consumes damage (~1888 tok)
- `divided-damage.test.ts` — Phase 3, slice 4a — divided damage (mig 115): the `divided_damage` action type (~1279 tok)
- `fight.test.ts` — Tier-2 effect: fight (migration 101) — the first multi-target effect. A (~2640 tok)
- `gain-control.test.ts` — Tier-2 effect: gain_control (migration 106) — Threaten / Mind Control on the (~1860 tok)
- `grant-keyword-spell.test.ts` — Tier-2 effect: grant_keyword spell/combat-trick path (migration 100). A (~789 tok)
- `grant-keyword.test.ts` — Tier-2 effect: grant_keyword — a targeted trigger gives a creature a keyword (~696 tok)
- `hybrid-phyrexian-mana.test.ts` — Phase 4 — richer mana: HYBRID and PHYREXIAN symbols (mig 121). pay_mana_cost (~1288 tok)
- `layer-pt.test.ts` — Phase 4 / F2.2a — set-P/T layering (mig 128, CR 613 layer 7b). A set_pt effect (~1829 tok)
- `modal-decisions.test.ts` — Phase 1, slice 2 — pending-decision machinery + modal "choose one". (~1917 tok)
- `multi-target-trigger.test.ts` — Phase 3, slice 4b — multi-target triggered abilities (mig 116). "When this (~1053 tok)
- `multi-target.test.ts` — Phase 3, slice 1 — general multi-target removal (mig 112): the (~1574 tok)
- `multiplayer.test.ts` — Commander (EDH) — multiplayer turn/priority/win loop (mig 140). The turn and (~1316 tok)
- `permanent-target.test.ts` — Phase 3, slice 2 — non-creature permanent targets (mig 113): the (~1370 tok)
- `permanent-trigger-target.test.ts` — Phase 3, slice 3 — non-creature permanent targets for TRIGGERED abilities (~1123 tok)
- `player-discard.test.ts` — Near-term authoring — player-targeted discard (mig 118). `discard` gains (~1141 tok)
- `priority-round.test.ts` — Phase 4 / F1b — a new stack object restarts the priority round (mig 124). Until (~626 tok)
- `protection.test.ts` — F3 — Protection (DEBT), slice 1: the "can't be Targeted" (T) gate (mig 131). (~2532 tok)
- `rls.test.ts` — Security — game-state reads are scoped to SESSION MEMBERS (mig 143). Two legacy (~732 tok)
- `sacrifice-reanimate.test.ts` — Phase 1, slice 11 — sacrifice and return_from_graveyard (raise dead / (~2740 tok)
- `search-library-variants.test.ts` — Phase 1, slice 14 — search_library variants (mig 111): graveyard destination, (~1560 tok)
- `x-spells.test.ts` — Phase 1, slice 12 — X spells (variable amount paid as {X} generic mana). (~1339 tok)

## tests/fixtures/

- `test-cards.json` (~6356 tok)

## tests/harness/

- `scenario.ts` — Create a session. Seat A is the creator + active player; B/C/D join in seat (~8843 tok)
- `seed.ts` — Seeds the `% Test` cards into public.cards for the local test DB. (~449 tok)

## tests/regression/


## tests/unit/

- `card-behavior-builder.test.ts` — Characterization tests for the guided-form ↔ script-JSON conversion in (~8972 tok)
- `deck-insights.test.ts` — Unit tests for the pure deck-statistics helpers (no DB). (~1780 tok)

## vercel/


## vercel/app/


## vercel/components/


## vercel/components/mtg/


## vercel/components/ui/


## vercel/hooks/


## vercel/lib/


## vercel/lib/mtg/


## vercel/styles/

