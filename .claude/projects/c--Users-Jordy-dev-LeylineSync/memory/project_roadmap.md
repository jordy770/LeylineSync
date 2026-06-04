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

1. **Dual-shape variant mechanism** — targeted `deal_damage` (Lightning Bolt) and targeted `add_counters` in the form. Blocked because those `type`s already have auto-resolve registry entries; needs a per-type disambiguator (registry is one-entry-per-`type`). *Next item if Lightning-Bolt-class cards are wanted in the form.*
2. **Modal spells authorable** — engine + targeted modes done (mig 091), but not authorable: needs a `spell_effect.modes` script shape + a mode/target cast UI.
3. **Player-targeted / spell-side effects** needing a **player picker** (shared infra unlocks several below):
   - spell-side / player-targeted `mill`
   - player-targeted `discard` (chosen vs random)

## 🟡 Mid-term — effect vocabulary (README Tier 1/2/3 backlog)

**Tier 1 (mirror an existing helper):** ✅ **shipped** (mig 098, by Codex)

- ~~`gain_life`/`lose_life` for **each/all players**~~ ✅ (new recipients each_player/all_players)
- ~~Mass `add_counters`~~ ✅ (`add_counters_all`, controller-scoped)
- ~~`tap_all` / `untap_all`~~ ✅ (controller-scoped)

**Tier 2 (target in another zone or a player choice):**

- Return from graveyard (`return_to_hand` / reanimate) — needs graveyard picker
- `sacrifice` (sacrificing player chooses)
- Gain control / control-change ("threaten"), optional until-end-of-turn
- ~~`fight`~~ — ✅ **fully shipped, end-to-end** (mig 101). Engine: `apply_fight` reads both creatures' `card_effective_power` then deals each one's power to the other via `apply_creature_effect('deal_damage')`; cast via `cast_fight(session, fighter, fought, source, fought_controller)`; `fight_creatures` resolve branch; fizzles if either left the field. Authoring: Zod `fight` action + KNOWN_V2, registry/builder entry (reuses the composite creature-target field for the FOUGHT creature; fighter implicit), LLM prose. Client: `castFight` wrapper + a **two-step picker** in ControllerListV4 (pick your fighter, then the fought creature). Fixture `Prey Upon Test`. First multi-target effect. **Trigger path also shipped** (mig 102): "when this enters, it fights target creature" — `trigger_effect_requires_creature_target` learns `fight`, `apply_targeted_triggered_ability_effects` dispatches `fight` to `apply_fight(session, SOURCE, picked target)` (source = fighter), reusing the existing trigger target picker (no new client UI); `apply_fight` gained a self-fight guard; registry contexts `['trigger','spell']`; BuilderEffect `fight`; fixture `Pit Brawler Test`. **Tail finished (mig 103):** deathtouch — `apply_creature_effect` deal_damage honours an optional `deathtouch` param (mirrors combat's `dealt_deathtouch_damage`), `apply_fight` captures both creatures' `card_has_deathtouch` up front; generic-mana — `cast_fight` now accepts/forwards `p_generic_payment` to `pay_mana_cost` (parity with put_action_on_stack; the client wrapper forwards null like every other creature cast — a generic-mana picker is a shared app-wide UI feature, not fight-specific). `fight` is now **fully complete, no remaining follow-ups.**
- ~~Temporary keyword grant~~ — ✅ **fully shipped** (mig 099 trigger path + mig 100 instant/combat-trick spell path: `grant_keyword_creature` stack action through `put_action_on_stack`/`resolve_top_of_stack`, client `putGrantKeywordCreatureOnStack` + `creature_effect` plan carrying `keyword`, authorable in both trigger & spell contexts). Keyword is fixed by the card, so cast only needs a creature target — no keyword picker.

**Tier 3 (higher effort / variable):**

- **X spells** (variable amounts)
- Search-library variants beyond current tutor

**Targeting reach (Phase 3 leftovers):**

- Targeted **player / permanent / non-creature** trigger targets
- **Multi-target** triggers
- Spell effects targeting non-creature permanents

## 🟠 Longer-term — rules-engine depth (Phase 4)

- Player-chosen combat damage **over-assignment** amounts
- Richer **mana model** (hybrid, X, Phyrexian)
- Fuller **priority/APNAP**, replacement / prevention / **protection** (incl. "can't be countered")
- Real **copy / control-change / suppression** cards
- Real **mana-retention** cards
- Activated abilities beyond `deal_damage` (others currently render "Soon")

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
