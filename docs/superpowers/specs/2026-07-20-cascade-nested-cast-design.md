# Cascade & Generalized Free Nested-Cast — Design Spec

**Date:** 2026-07-20
**Status:** Approved design, pre-implementation
**Author:** Jordy + Claude (brainstorm)

## 1. Problem & motivation

Cascade is unimplemented in the LeylineSync card-behavior SQL engine. Corpus ROI is
strong: **55 cards** reference cascade in `cards.oracle_text`; only 1 (Bituminous
Blast) currently has any script.

The hard part of cascade is not the trigger — it is the payload: *exile from the top
of the library until a nonland with lesser mana value, then **cast that card for
free** (with its own targets and ETB triggers), and bottom the rest in a random
order.*

Every existing free-cast in the engine (`discover`/Pantlaza, Etali, Breaching
Dragonstorm) **approximates** the "cast for free" step: a found permanent enters the
battlefield directly (no stack, no cast, ETB *triggered* abilities may not fire) and a
found instant/sorcery goes to hand instead of being cast. That approximation was
explicitly rejected for cascade — cascade hits instants/sorceries far more often than
discover does, and a cascade that "draws" a burn spell instead of casting it is
visibly wrong.

**Decision (product):** build the real thing — a *generalized free nested-cast with
target selection* — and make cascade its first consumer. This is the engine's biggest
missing primitive.

## 2. Scope

### In scope (v1)

- A generalized free-caster: `cast_card_free(session, game_card_id, controller)` that
  truly casts a card from any zone onto the stack for free.
- A target-requirement adaptor: `spell_free_cast_target_spec(script)`.
- A shared cast-trigger enqueuer: `enqueue_cast_triggers(session, card_id, controller)`.
- A `cascade` effect handler (adapted from `discover`).
- A `cascade` script marker (`count` default 1).
- Card scripts for **intrinsic** cascade: ~29 plain + ~5 multi-cascade ≈ **34 cards**.
- **Spell-shape coverage:** no-target, single cast-time target, and effect-owned
  richer targeting (divided damage, per-opponent, modal-at-resolution — parked by the
  effect actions themselves during resolution). Permanents (incl. Auras via the same
  target path).

### Out of scope (deferred, enabled by v1 — separate increments)

- **granted-cascade** (static "the first/next/qualifying spell you cast has cascade" —
  Imoti, The First Sliver, Yidris, Maelstrom Nexus, Rain of Riches, +~13 cards): needs
  a continuous effect that stamps cascade onto qualifying casts.
- **cascade-payoff** (Aurora Phoenix, The First Doctor: "whenever you cast a spell with
  cascade…"): a small `cast_with_cascade` watcher event.
- **as-you-cascade** replacement (Averna: put a land into play mid-cascade).
- **Uncovered cast-time spell shapes:** modal ("choose one —"), X-cost at cast, and
  divided-damage-at-cast. These hit the fallback (Section 6) in v1.
- **Migrating existing approximations** (discover, Etali, Breaching Dragonstorm) onto
  `cast_card_free`. They keep their shipped behavior in v1 to avoid destabilizing live
  cards; opportunistic follow-up.

## 3. Architecture

Approach A (chosen): reuse the shipped triggered-ability stack machinery for
*targeting*, run the spell's own effect program for *resolution*. Rejected: a
parallel spell-target subsystem (duplication, new bot code) and client-side
pre-resolution (breaks the server-authoritative stack, no bot path).

### New components

**`cast_card_free(session, game_card_id, controller)`** — entry point. Dispatches by
the found card's type:

- **Instant / Sorcery:** read `script.actions`; ask the adaptor for target needs.
  - *No target* → call `cast_spell_effect(actions, card, x:=0)` directly. Free by
    construction — `cast_spell_effect` never charges mana (payment happens in the play
    RPC *before* it is called; here there is no such step). Mirrors the flashback /
    free-cast fixtures.
  - *Needs a cast-time target* → park a decision in the **triggered-ability target
    payload shape** (`target_required`, `target_type`, `target_controller`,
    `target_count:1`), status `awaiting_decision`. On target chosen, call
    `cast_spell_effect(actions, card, 0, chosen_target)`.
- **Permanent** (creature / artifact / enchantment / planeswalker / battle / land) →
  push a real `cast_permanent` stack item from exile (the same push
  `cast_card_from_hand` performs, minus the payment step). Resolves through the normal
  loop **with genuine ETB triggers** — the concrete upgrade over today's direct-entry.
  Auras (a targeting permanent) route through the same target-parking as targeted
  spells.

**`spell_free_cast_target_spec(script) → {required, target_type, target_controller}`**
— the one genuinely new piece of logic. Scans a spell's actions for the primary
cast-time targeted action and returns its target spec, or `{required:false}`, or the
sentinel `unsupported` for shapes it cannot model (→ fallback).

**`enqueue_cast_triggers(session, card_id, controller)`** — scans a just-cast card's
script for cast-time self-triggers (cascade today; future cast triggers later) and
enqueues them. Called from the three points a card becomes cast:
`cast_card_from_hand` (permanent spells, at the existing `spell_cast` watcher call),
`cast_spell_effect` (instants/sorceries, likewise), and `cast_card_free`'s permanent
push. One home → **recursion falls out for free** (a cascaded cascade spell fires
again; terminates because each cascade strictly lowers the MV window and the library
depletes).

**`cascade` effect handler** (adapted from `discover`, not reused verbatim): exile
from the top until a nonland with **MV < the cast spell's MV** (integer MV, so this is
discover's `<=` with `amount = castMV − 1`), then Decision 1 (Section 4).

### Reused unchanged

Decision parking table (`game_pending_decisions`), `choose_triggered_ability_targets`
(with a guard relaxation — Section 4), the bot `resolveTriggerTargets` auto-picker,
`creature_target_controller_ok` / `permanent_target_controller_ok`, `cast_spell_effect`,
`handle_cast_permanent`, `bottom_cards_random`, the stack resolution loop.

## 4. Target-parking & resolution flow

A found spell moves through up to two decisions, then resolves on the real stack.

**Decision 1 — "cast it for free?" (cascade's *may*).** After the exile-until-lesser
loop, the cascade handler parks a yes/no decision in the existing `cast_exiled_free`
shape. This is cascade's optional-cast and lives in the *caller* (the cascade
handler), NOT in `cast_card_free` — `cast_card_free` unconditionally casts, keeping it
reusable by non-optional callers later.

- **Decline / no legal play** → the found card joins the looked-at pile and bottoms in
  random order (`bottom_cards_random`). No card goes to hand (cascade RAW).

**Decision 2 — target selection (only if the found card targets).** On "yes",
`cast_card_free` calls the adaptor. If a cast-time target is required, it parks a
decision carrying the triggered-ability target payload keys. Two existing consumers
then work with no new target logic:

- `choose_triggered_ability_targets` (human path), and
- the bot's `resolveTriggerTargets` auto-picker.

The only edit either needs is a **guard relaxation**: `choose_triggered_ability_targets`
currently rejects `action_type <> 'triggered_ability'`; widen it to also accept the
free-cast context. Same one-line widening on the bot's single-target RPC
(`choose_triggered_ability_creature_target`). Legality still runs through the untouched
`*_target_controller_ok` helpers.

**Resolution — the found card truly hits the stack.** Once the target (if any) is set:

- Instant/sorcery → `cast_spell_effect(actions, found, x:=0, target)` pushes a real
  `cast_spell` stack item, resolved by the normal loop.
- Permanent → the `cast_permanent` push resolves with genuine ETB triggers.

Because the found card is pushed *above* the cascade item (LIFO), it resolves before
cascade finalizes — matching how a cascaded spell sits atop the cascade trigger in
real MTG. Effect-owned richer targeting is parked by those effect actions themselves
during their resolution; the free-caster never models it.

**Two implementation-time verifications (must pin with tests, not assume):**

1. The guard relaxation does not loosen legality anywhere it should not.
2. The stack resume/ordering genuinely resolves the pushed spell before the cascade
   item finalizes — confirm against the resolve loop and pin with a test.

## 5. Cascade representation

- Card script gains a `cascade` marker; `count` defaults to 1. Apex Devastator =
  `cascade: {count: 4}` → four cascade items enqueued.
- `enqueue_cast_triggers` reads it and enqueues cascade as a normal `triggered_ability`
  stack item with effect `type:'cascade'`, riding the existing trigger→resolve infra.
- Threshold is the **cast spell's own mana value**, strict `<`.

## 6. Fallback taxonomy (uniform, RAW-honest)

Whenever the engine cannot truly cast the found card, it **bottoms in random order —
never to hand** (matches the "no free card advantage" intent):

- Adaptor returns `unsupported` (modal / X-at-cast / divide-at-cast spell) → bottom, logged.
- Targeted spell with no legal target (or a bot with none) → bottom (uncastable).
- Player declines the may-cast → bottom.

Permanents never reach the fallback — always castable via the `cast_permanent` push.

## 7. Card rollout

Measured against the live corpus (55 unique cards with a real `cascade` keyword):

- **29 plain** intrinsic cascade → script `cascade` (count 1). v1.
  - Annoyed Altisaur, Ardent Plea, Bituminous Blast, Bloodbraid Elf, Boarding Party,
    Captured Sunlight, Demonic Dread, Deny Reality, Enigma Sphinx, Enlisted Wurm,
    Etherium-Horn Sorcerer, Ethersworn Sphinx, Forceful Denial, Garbage Elemental,
    Heralds of Tzeentch, Ingenuity Engine, Into the Time Vortex, Kathari Remnant,
    Let the Galaxy Burn, Maelstrom Colossus, Meteoric Mace, Natural Reclamation,
    Noise Marine, Sakashima's Protege, Shardless Agent, Stormcaller's Boon,
    Throes of Chaos, Violent Outburst, Volcanic Torrent.
- **~5 multi-cascade** → `cascade: {count: N}`. v1.
  - Apex Devastator (4), Maelstrom Wanderer (2), Zhulodok Void Gorger, Call Forth the
    Tempest, plus per-card check of the `?`-flagged (Bigger on the Inside, Bloodbraid
    Challenger, Bloodbraid Marauder, Sweet-Gum Recluse) during scripting.
- **~21 deferred** (grants-cascade / payoff / as-you-cascade — Section 2).

## 8. Testing strategy

Feature tests in `tests/feature/`, mirroring the discover / per-opponent test style:

1. Found permanent → enters via real `cast_permanent`; its ETB trigger fires.
2. Found no-target spell → truly cast; effect applies.
3. Found targeted spell → target decision parks → `choose_triggered_ability_targets`
   → resolves against the chosen target.
4. Nothing castable / decline → all bottom, none to hand.
5. Unsupported shape (modal) → bottom fallback.
6. Recursion → a found cascade spell cascades again.
7. Multi-cascade `count:2` → two resolutions.
8. Bot caster auto-targets via `resolveTriggerTargets`.
9. Threshold: a card at exactly the cast spell's MV is skipped (strict `<`).

Round discipline (per the established workflow): migration code-only diff-check
(strip `--` comment lines to avoid em-dash/→ mojibake false diffs) vs the latest
`create or replace` migration; `node scripts/new-migration.mjs`; full
`node scripts/run-tests.mjs`; `rm -f tsconfig.tsbuildinfo && npx tsc --noEmit`;
eslint. Migration-only fns hand-copied from their latest migration.

## 9. Deploy

`gh release create vX --target master` → `deploy.yml` db-pushes migrations + rebuilds
the VPS; then `node --import tsx scripts/upsert-deck-scripts.mjs <all-cards-deck.txt>
--apply --force` (runtime reads scripts from hosted `cards.script`). Verify: re-dry-run
0 diffs + site 200.

## 10. Open risks

- **Stack resume ordering** (Section 4, verification 2) is the highest-risk unknown —
  the found spell must resolve above the cascade item. If the resume model finalizes
  the cascade item before the pushed spell resolves, the ordering approximation needs
  adjustment. Pinned by test 6 + a dedicated ordering test.
- **Adaptor coverage drift:** `spell_free_cast_target_spec` must fail *closed* (return
  `unsupported` → bottom) for any shape it does not recognize, never silently mis-target.
- **Guard relaxation blast radius:** widening `choose_triggered_ability_targets` must
  not let a player retarget a genuine triggered ability in an illegal way. Scope the
  widening to the specific free-cast `action_type`/context only.
