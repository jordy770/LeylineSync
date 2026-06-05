---
name: project-roadmap
description: LeylineSync combined roadmap — shipped features and remaining work, reconciled across all sources as of 2026-06-04
metadata:
  type: project
---

# LeylineSync — Combined Roadmap (as of 2026-06-04)

> Single source of truth. Consolidates the old `project_roadmap.md` (2026-05-27),
> the README "Effect roadmap" (Tier 1/2/3) and "## Roadmap"/Phased plan, and the
> cerebrum Decision Log "next item" notes. Status reconciled against the engine
> through **migration 097** and the registry-driven card-behavior form.

## ✅ Shipped (foundation — don't re-plan)

- Sessions, membership, locking, finishing, win/loss
- Deck text-import, deck editor, randomized library spawn
- Zones (library/hand/stack/battlefield/graveyard/exile); manual + rule-driven movement
- Mana pool, player-chosen generic payment, effect-aware clearing
- Turn structure (phases/steps/rotation), auto untap + draw
- Priority passing, stack model, counterspell cancellation, permanent spells via stack
- Combat: declare attackers/blockers, multi-block ordered damage, lethal→graveyard, SBA 0-toughness sweep
- Keywords: vigilance, trample, indestructible, first/double strike, deathtouch, haste, **flying/reach**; summoning sickness
- +1/+1 counters, until-end-of-turn pumps, token creation
- Continuous-effect lifecycle rebuild (copies, control change, suppression)
- Cleanup-step hand-size discard (V4 controller)
- **Zod script validation** (V1+V2) + `npm run validate:scripts`
- **Card-behavior authoring** at `/cards/behavior`: registry-driven guided form, JSON mode, AI generate
- **Triggered abilities:** ETB, dies, leaves, upkeep/draw/end-step, attacks, blocks, becomes-targeted — auto-resolve + targeted-creature triggers w/ `target_controller`
- **Spell effects via stack:** deal_damage, pump, destroy, exile, bounce, tap, untap, draw, counter, add_mana
- **Decision/interactive effects (pending-decision state machine):** scry, surveil, search_library (tutor), discard, may, choose_player, modal spells — all with in-game decision-prompt UI
- **Targeted-creature effects in the guided form** (destroy/exile/bounce/tap/untap/pump via composite `target` field)
- **Test chamber:** programmatic harness vs local Supabase (53 engine tests) + 121 form characterization tests
- **SQL Phase-0 centralizations:** `put_in_graveyard`, `effective_script`, `apply_creature_effect`, `finalize_stack_resolution`, `apply_trigger_effects`, `resume_or_finalize`

## 🔜 Near-term — authoring & form gaps (low risk, high value)

1. ~~**Dual-shape variant mechanism**~~ — ✅ **shipped (form-only, no migration)**. Targeted `deal_damage` (Lightning Bolt) + targeted `add_counters` now authorable in the guided form. EffectDef gained optional `variant` (form key = `variant ?? type`); `resolveEffectDef`/`effectKeyOf` pick the def by the effect's fields; `effectFromJson` tries all defs per type. New `deal_damage_target` (spell) + `add_counters_target` (spell+trigger) defs + `damageTargetField`. NO engine/Zod change — the engine already cast these; only the form couldn't author them. **Reusable: add a def with a unique `variant` + a discriminating field for any future dual-shape.**
2. ~~**Modal spells authorable**~~ — ✅ **shipped (JSON/AI authoring + playable, mig 117)**. spell_effect gained `modes` + `choose` (Zod); getSpellPlan → modal plan → castModalSpell; the existing ChooseModeBody resolves mode+target. **mig 117 fixed cast_modal_spell to pay mana + graveyard the source (was free + stayed in hand, bug-262).** LLM documents the Charm shape + the "simple effects only in a mode" engine limit. NO guided-form modes editor (user chose the smaller scope) and NO decision effects inside modes — both are the open follow-ups.
3. ~~**Player-targeted / spell-side effects**~~ — ✅ **shipped**:
   - ~~spell-side / player-targeted `mill`~~ — ✅ **already covered** by `choose_player` + `mill` ("target player mills N"). Documented; nothing built.
   - ~~player-targeted `discard` (chosen vs random)~~ — ✅ **shipped (mig 118)**. `discard` gained `who: 'you'|'opponent'` (Mind Rot) + `random: true` (Hymn). Chosen → choose_cards decision lands on the discarding player; random → N random hand cards to graveyard, no decision. No client change (generic decision UI). Tests PD1–PD4. *Follow-up: each_opponent discard + multiplayer target-opponent pick.*

**✅ All near-term authoring/form-gap items shipped** (dual-shape variant, modal spells, player-picker effects).

## 🟡 Mid-term — effect vocabulary (README Tier 1/2/3 backlog)

**Tier 1 (mirror an existing helper):** ✅ **shipped** (mig 098, by Codex)

- ~~`gain_life`/`lose_life` for **each/all players**~~ ✅ (new recipients each_player/all_players)
- ~~Mass `add_counters`~~ ✅ (`add_counters_all`, controller-scoped)
- ~~`tap_all` / `untap_all`~~ ✅ (controller-scoped)

**Tier 2 (target in another zone or a player choice):** ✅ **all shipped**

- ~~Return from graveyard (`return_to_hand` / reanimate)~~ — ✅ **COMPLETE** (mig 108). `return_from_graveyard` effect `{to:'hand'|'battlefield', count?, filter?}` — decision-machine park/resume via apply_trigger_effects (works in triggers AND spell_effect programs); picks up to N from the controller's own graveyard (default creatures), to hand (Raise Dead) or battlefield (Reanimate — controller=owner, untapped, fires ETB). Reuses `CardPickBody` (`{chosen}` shape). Tests RG1/RG2/RG3.
- ~~`sacrifice` (sacrificing player chooses)~~ — ✅ **COMPLETE** (mig 108). `sacrifice` effect `{who:'you'|'opponent', count?, filter?}` — the sacrificing player (controller, or the opponent for an edict) is the decision's deciding_player; options = creatures they control; apply loops `put_in_graveyard` (fires dies triggers). Default filter creatures. Tests SAC1/SAC2/SAC3. Multi-opponent "each opponent sacrifices" — ✅ **shipped (mig 110)**: `who:'each_opponent'` chains a sequential decision per opponent (the parked decision carries the remaining-opponent queue in params; resumes only when the queue empties), via shared helper `park_edict_sacrifice`; `who:'you'/'opponent'` route through it too (SAC1–3 unchanged). 3-player harness (`Scenario.create(client, 3)`). Tests ME1–ME3. **All Tier-2 vocabulary now shipped.**
- ~~Gain control / control-change ("threaten")~~ — ✅ **COMPLETE, end-to-end** (mig 106 trigger + mig 107 spell/threaten). TRIGGER path (mig 106). `gain_control` kind in apply_creature_effect: permanent = direct controller_player_id UPDATE; `duration:end_of_turn` = UPDATE + a `'control'` continuous-effect row carrying `{original_controller}`, reverted by a new RESTORE step in `expire_continuous_effects_for_step` (the sweep is otherwise delete-only; control is a DIRECT column, not a read-through layer). Acting controller threaded via `apply_targeted_triggered_ability_effects` injecting `acting_controller` into the effect params (no apply_creature_effect signature change). Routed through the creature-target picker (trigger_effect_requires_creature_target += gain_control). Authoring: registry (duration enum + creatureTargetField, trigger-only), Zod, BuilderEffect, LLM. Fixtures Usurp Brute Test (EOT) / Dominate Beast Test (permanent). **SPELL path + threaten extras (mig 107):** gain_control honours optional untap/haste (Act of Treason); `gain_control_creature` spell action via the 104/105 registry with ZERO put/resolve reproduction (1 builder + 1 registry row + handle_creature_effect injecting acting_controller=stack_item.controller); client wiring (putGainControlCreatureOnStack + getSpellPlan); authorable in both contexts (registry ['trigger','spell'], BuilderSpellEffect, Zod untap/haste). Tests GC1–GC5 (228/228). No remaining follow-ups.
- ~~`fight`~~ — ✅ **fully shipped, end-to-end** (mig 101). Engine: `apply_fight` reads both creatures' `card_effective_power` then deals each one's power to the other via `apply_creature_effect('deal_damage')`; cast via `cast_fight(session, fighter, fought, source, fought_controller)`; `fight_creatures` resolve branch; fizzles if either left the field. Authoring: Zod `fight` action + KNOWN_V2, registry/builder entry (reuses the composite creature-target field for the FOUGHT creature; fighter implicit), LLM prose. Client: `castFight` wrapper + a **two-step picker** in ControllerListV4 (pick your fighter, then the fought creature). Fixture `Prey Upon Test`. First multi-target effect. **Trigger path also shipped** (mig 102): "when this enters, it fights target creature" — `trigger_effect_requires_creature_target` learns `fight`, `apply_targeted_triggered_ability_effects` dispatches `fight` to `apply_fight(session, SOURCE, picked target)` (source = fighter), reusing the existing trigger target picker (no new client UI); `apply_fight` gained a self-fight guard; registry contexts `['trigger','spell']`; BuilderEffect `fight`; fixture `Pit Brawler Test`. **Tail finished (mig 103):** deathtouch — `apply_creature_effect` deal_damage honours an optional `deathtouch` param (mirrors combat's `dealt_deathtouch_damage`), `apply_fight` captures both creatures' `card_has_deathtouch` up front; generic-mana — `cast_fight` now accepts/forwards `p_generic_payment` to `pay_mana_cost` (parity with put_action_on_stack; the client wrapper forwards null like every other creature cast — a generic-mana picker is a shared app-wide UI feature, not fight-specific). `fight` is now **fully complete, no remaining follow-ups.**
- ~~Temporary keyword grant~~ — ✅ **fully shipped** (mig 099 trigger path + mig 100 instant/combat-trick spell path: `grant_keyword_creature` stack action through `put_action_on_stack`/`resolve_top_of_stack`, client `putGrantKeywordCreatureOnStack` + `creature_effect` plan carrying `keyword`, authorable in both trigger & spell contexts). Keyword is fixed by the card, so cast only needs a creature target — no keyword picker.

**Tier 3 (higher effort / variable):**

- ~~**X spells** (variable amounts)~~ — ✅ **COMPLETE end-to-end (mig 109 + client)**. `amount: "X"` in the script (Zod `AmountSchema`); caster picks X at cast (ControllerListV4 `promptForXValue`), engine charges real `{X}` generic mana (`pay_mana_cost` now parses `{X}`) and resolves X **server-side** (tied to mana paid — client never sends a trusted number, only `amount:'X' + x_value`). BOTH paths: targeted `put_action_on_stack` (X in payload, builders resolve via `resolve_effect_amount`) + untargeted `cast_spell_effect` (substitutes "X", **now pays mana** — was free). Client: getSpellPlan damage/draw/add_counters/spell_effect detect `amount==='X'` → `xRequired`; 5 handlers prompt + pass xValue; 5 actions.ts wrappers thread it. No mana-colour picker (generic auto-distributes). Tests X1–X5 (244/244). Fixtures Fireball Test {X}{R} / Mind Spring Test {X}{U}.
- ~~Search-library variants beyond current tutor~~ — ✅ **shipped (mig 111)**. Four backward-compatible additions to `search_library`: `to:'graveyard'` (Entomb), `tapped:true` (Rampant Growth/fetch — enters tapped), `filter.name` (search by name), and `reveal:true` (records found ids in `result.revealed` — metadata only; this engine has no opponent-reveal modeling). `graveyard` is in the guided form (enum); `tapped`/`reveal`/`filter.name` are JSON/AI-only (Zod + LLM), matching the gain_control untap/haste precedent — the object-field serializer can't drop an empty nested sub-field (bug-230). Tests SLG1/SLT1/SLT2/SLN1/SLR1/SLR2.

**Targeting reach (Phase 3 leftovers):**

- ~~**Multi-target** (removal family)~~ — ✅ **shipped (mig 112)**, spell side. New `multi_creature_effect` action type: destroy/exile/bounce/tap/untap of up to N creatures (full effect to each), via the 104/105 data-driven dispatch (1 builder + 1 handler + 1 registry row; single-target paths untouched). Authoring: removal effects gained optional `targets?: number` (Zod + LLM, `targets>1` → multi); client multi-select picker. apply_creature_effect no-ops a gone target → resolves for legal targets. Tests MT1–MT6. **Note:** action_type CHECK needed updating (bug-235). Remaining multi-target: TRIGGER side, and DIVIDED damage (Forked Bolt — variable per-target amounts, deferred as a larger shape).
- ~~Spell effects targeting **non-creature permanents**~~ — ✅ **shipped (mig 113)**, spell side. New `permanent_effect` action type: destroy/exile/bounce/tap/untap a target artifact/enchantment/land/planeswalker/"permanent" (Disenchant, Naturalize, Vindicate, Beast Within). apply_creature_effect already worked on any permanent; added type-aware validators (`card_type_line_matches_target`, `permanent_target_controller_ok`) + a type-aware client picker. Zod already permitted the target_type; LLM updated. Tests PE1–PE6.
- ~~Targeted **player-target trigger** targets~~ — ✅ **already covered** by `choose_player` (parks a player decision in triggers + spells; applies lose_life/gain_life/draw/mill to the chosen player). Nothing to build.
- ~~**Non-creature permanent** targets for **triggered abilities**~~ — ✅ **shipped (mig 114)**. "When this enters/dies, destroy target artifact." Generalised the announcement-time trigger-target path (enqueue/picker/fizzle/apply, 5 reproduced fns + 4 new helpers) from creature-only to "a target whose type the effect allows", keyed off `trigger_effect_target_type`; creature path byte-identical (PTT4 + all prior trigger tests green). destroy/exile/bounce/tap/untap only. Client TriggerTargetPrompt filters by payload target_type. Tests PTT1–PTT4.
- ~~DIVIDED damage~~ — ✅ **shipped (mig 115)**. `divided_damage` action type: "deal N divided among any number of target creatures/players" (Forked Bolt). Builder validates allocations sum to N + distinct targets; handler loops (creature → apply_creature_effect, player → life loss). deal_damage Zod `divided?:boolean`; client +/- allocation UI. Tests DD1–DD5.
- ~~MULTI-target triggers~~ — ✅ **shipped (mig 116)**. A removal trigger effect carries `targets:N`; new `choose_triggered_ability_targets` RPC picks up to N; `apply_trigger_effects` loops the targeted effect over each target (non-targeted effects still applied once — the key subtlety). Client TriggerTargetPrompt multi-select + Confirm. Tests MTT1–MTT4.
- **✅ TARGETING REACH COMPLETE** — players (choose_player), non-creature permanents (mig 113/114), multi-target (mig 112/116), divided damage (mig 115). (Only divided damage on the trigger side is unbuilt; no demand noted.)

## 🟠 Longer-term — rules-engine depth (Phase 4)

- ~~Player-chosen combat damage **over-assignment** amounts~~ ✅ **shipped (mig 122)**: resolve_combat_damage gained optional `p_assignments` (attacker→{blockers:[{blocker_card_id,amount}], trample}); a validation pre-pass enforces CR 510.1c (lethal before later blockers / trample), then the loop applies the chosen distribution; null = byte-identical auto min-lethal (no regression). Client: per-blocker damage steppers + a trample stepper added to the existing multi-blocker sheet in ControllerListV4. Tests CO1–CO4.
- ~~Richer **mana model** (hybrid, X, Phyrexian)~~ ✅ **shipped** — X (mig 109) + **hybrid/Phyrexian (mig 121)**: pay_mana_cost parses {W/U} (either colour), {2/W} (2 generic or colour), {W/P} (colour or **2 life**), auto-resolving each symbol (optional explicit choice via `p_hybrid_payment`). Casters unchanged (auto-default); a hybrid/life picker is a shared-UI follow-up. Tests HM1–HM6.
- Fuller **priority/APNAP**, replacement / prevention / **protection** — **NOW IN PROGRESS as the "frontier" phase (incremental PL/pgSQL, isolated resolvers — see cerebrum 2026-06-05 F1a).** ~~APNAP ordering of simultaneous triggered abilities~~ ✅ **shipped (mig 123, F1a)**: enqueue stamps apnap_rank; order_pending_triggers settles the batch (active player's triggers resolve last); resolve_top_of_stack settles before picking the top. Tests AP1–AP3. ~~F1b priority_pass_count reset on cast~~ ✅ **shipped (mig 124)**: an AFTER INSERT trigger on game_stack_items restarts the priority round on any new stack object (fixes respond-then-pass short-circuit). Tests PR1/PR2. **F1 (priority/APNAP) complete.** F2 (replacement engine) IN PROGRESS: ~~F2.1a damage-prevention resolver~~ ✅ **(mig 125)** — `game_damage_prevention` shields + `apply_damage_to_player` resolver wired into deal_damage_player (DP1–DP4). ~~F2.1b prevent_damage card effect~~ ✅ **(mig 126)** — program action `{type:'prevent_damage', amount?, combat_only?}` shields the caster; Zod/LLM/fixture; tests PV1/PV2. ~~F2.1c combat damage through the resolver~~ ✅ **(mig 127)** — unblocked + trample player damage now consult the resolver (combat_only/Fog shields work); tests CP1–CP3. **Player damage prevention COMPLETE (spell/ability/combat).** ~~F2.2a set-P/T layer~~ ✅ **(mig 128)** — `set_pt` continuous effect; card_effective_power/toughness CR-613-7b-aware (set replaces base, then counters/pumps; latest set wins); tests L1–L4. ~~F2.2b "becomes X/Y" spell~~ ✅ **(mig 129)** — `set_pt_creature` registry action + `set_pt` kind in apply_creature_effect (until-EOT); Zod/LLM/fixture (Frogify Test); tests SP1–SP3 (becomes 0/1, counter layers, wears off). **Remaining F2: set_pt trigger path + client getSpellPlan wiring; anthem (static/source-gated) set effects; layer 7e switch + 7a CDA; creature shields; opponent/chosen-player shields; redirect/replacement beyond prevention. Then F3 protection (DEBT).** ⚠️ `npm run validate:scripts` pre-broken (bug-282). ⚠️ `npm run validate:scripts` is pre-existing broken (bug-282). — ~~"can't be countered"~~ ✅ **shipped (mig 120)**: top-level `cant_be_countered: true`; handle_counter_spell reads the target spell's source-card script at resolution and skips cancellation (counter resolves but does nothing). JSON/AI-authorable (no guided-form surface). Tests CC1/CC2.
- Real **copy / control-change / suppression** cards
- Real **mana-retention** cards
- ~~Activated abilities beyond `deal_damage`~~ — ✅ **shipped (mig 119 + builder/form refactor)**. "{cost}: effect" abilities resolve the full vocabulary (destroy/exile/bounce/tap/untap/add_counters/pump/grant_keyword/gain_control of a target creature + untargeted draw) and are guided-form authorable. activate_ability dispatches the effect → put_action_on_stack action_type (engine was 95% ready; only the deal_damage-only check blocked it). Builder's bespoke 'damage' kind → generic 'effect' kind reusing the shared registry effect editor. Controller 'Soon' gate cleared for supported effects; per-effect target picker. Tests AA1–AA4. **Extending = one more arm in activate_ability.**

## 🔵 Architecture frontier (deferred by design — cerebrum Decision Log 2026-06-01)

- **`effective_characteristics`** accessor (one face/script accessor) — unlocks DFCs (Jill // Shiva); the seam already reserved in `effective_script`
- Broader **`apply_effect`** unification (one effect switch shared by spells/abilities/triggers) — `apply_creature_effect` is the first slice
- **Pure-TS `reduce(state, action)` rules core** — only at the replacement-effect / layer-system frontier (Noctis-class: cast-from-graveyard, additional costs, finality counters). Justified there by shared client/server optimistic UI + deterministic replay. **Not a rewrite-now.**

## ⚪ Operational (Phase 5)

- Scheduled cleanup of finished-game runtime data (explicit RPC/job, not in `maybe_finish_game_session`)
- Hidden-zone RLS hardening if private decklists matter
- Silence the stray parent `package-lock.json` build warning (`turbopack.root`)

---
**Why:** Consolidated at the user's request from four drifted roadmap sources so there's one current view.
**How to apply:** When the user asks "what's next," pull from Near-term first, then Mid-term. The dual-shape variant and player-picker infra are the two highest-leverage unlocks. Keep this reconciled with cerebrum Decision Log as work ships.
