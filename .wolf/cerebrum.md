# Cerebrum

> OpenWolf's learning memory. Updated automatically as the AI learns from interactions.
> Do not edit manually unless correcting an error.
> Last updated: 2026-05-27

## User Preferences

<!-- How the user likes things done. Code style, tools, patterns, communication. -->

## Key Learnings

- **Project:** LeylineSync
- **Description:** Realtime Magic: The Gathering style board/controller app built with Next.js and Supabase.
- **Card behavior resolution chain:** runtime reads behavior as `coalesce(game_cards.copied_script, cards.script)` across ~10 SQL functions (casting, rebuild_scripted_continuous_effects, activate_ability, combat keyword registration). `copied_script` = per-instance copy override; `cards.script` = base.
- **The Scryfall importer never writes `cards.script`** (scripts/import-scryfall-cards.mjs `mapScryfallCardToRow` omits it) and upserts `onConflict: 'id'`, so `ON CONFLICT DO UPDATE` leaves `cards.script` untouched → authored behavior survives reimports. This is why Phase 2 authored directly onto `cards.script` instead of building a separate oracle_id-keyed override table.
- **`cards.id` is the Scryfall printing id, not oracle identity.** `oracle_id` (added migration 075) is the card identity shared across printings; importer now persists it. Use `relink_card_scripts()` to re-attach a script if the representative printing for an oracle changes between imports.
- **State-based actions:** 0-toughness death (rule 704.5f) ignores indestructible; lethal marked damage (704.5g) is prevented by indestructible. Both handled in `move_lethal_damaged_creatures_to_graveyard` (migration 074).
- **Triggered abilities (migrations 076–077):** events detected by DB row triggers (mirrors the `cease_token` pattern). `fire_zone_change_triggers` on `game_cards` handles ETB (zone→battlefield) and dies (battlefield→graveyard); `fire_upkeep_triggers` on `game_turn_state` step→upkeep; `fire_attack_triggers` on `game_combat_assignments` insert. Each match calls `fire_card_triggers` → `enqueue_triggered_ability`, which inserts a `triggered_ability` stack item with effects + controller + source card name (`label`) baked into the payload (so resolution + display survive the source leaving). `resolve_top_of_stack` applies untargeted effects (gain_life/lose_life/deal_damage to controller|each_opponent, draw). Zone-change trigger name `trg_a_fire_zone_change` sorts before `trg_cease_token_off_battlefield` so a token's dies trigger enqueues before cease-to-exist; `game_stack_items.source_card_id` is ON DELETE SET NULL so the stack item survives, and `get_stack_items` coalesces `source_card.name` with the payload `label`. **Only targeted triggers remain unbuilt.**
- **`get_stack_items` was redefined in migrations 030→032→033**; the live version (033) has extra `target_player_id`/`target_username` columns. When reproducing it, base on 033, not 030, or you silently drop columns the client `StackItem` type depends on.
- **Triggered-ability effects live in `apply_triggered_ability_effects` (migration 078)** — a helper `resolve_top_of_stack` calls for the `triggered_ability` branch. To add a new auto-resolved trigger effect, edit this one function (no longer reproduce the whole resolve_top_of_stack). Supported: gain_life, lose_life, deal_damage (recipient controller|each_opponent), draw, create_token (by token name from seeded catalog), add_counters (+1/+1 on source). create_token inserts battlefield game_cards which itself fires the ETB zone-change trigger — intended.
- **Card behavior authoring stack:** `/cards/behavior` editor has Form mode (guided builder, `components/CardBehaviorForm.tsx` + model/codec in `lib/game/card-behavior-builder.ts`), JSON mode, and ✨ Generate-with-AI. The builder's vocabulary constants are the single source of truth: the form dropdowns, the LLM prompt (`lib/game/card-behavior-llm.ts` → `buildBehaviorAuthoringGuide`), and validation (`validateCardScript`) all derive from / agree on them. To add a new effect type, extend the builder + the Zod schema; the form and AI follow. AI route: `app/api/cards/generate-behavior/route.ts` — auth-gated, `claude-opus-4-8`, adaptive thinking, cached system prompt, validates output with `validateCardScript` and retries once; guarded by `ANTHROPIC_API_KEY` (returns 501 if unset). SDK: `@anthropic-ai/sdk`.
- **Reusable internal effect helpers:** `draw_card`/`adjust_player_life` RPCs gate on `auth.uid()` so they can't be reused for an arbitrary trigger controller; triggered-ability resolution applies life/draw inline against the payload's `controller_player_id` instead.
- **Spell effect types via the stack (migration 079):** `spell_effect.actions` types map to stack action types in `getSpellPlan` (ControllerListV4): `deal_damage`→deal_damage_creature/player, `pump`→pump_creature, `destroy/bounce/tap/untap`→`*_creature` (kind `creature_effect`, one shared V4 picker via `CREATURE_EFFECT_MAP`), `draw`→`draw_cards` (untargeted, kind `draw`, cast button calls onDrawCards not onCastCard). `draw_cards` resolution reuses `apply_triggered_ability_effects` with a synthetic `{type:draw}` effect (pass null source). destroy→owner's graveyard (fires `dies` triggers, intended), bounce→owner's hand (does NOT fire dies — that's only battlefield→graveyard); both reset is_tapped/damage/counters and controller→owner. **Gotcha:** `doesCardRequireStackTarget` returns true for ANY instant/sorcery whose oracle_text contains "target", which would gate these on a non-empty stack (counterspell behavior). `getSpellPlan` must classify the new kinds BEFORE the counterspell fallback, and `canCastHandSpell` special-cases damage/pump/creature_effect/draw to cast at natural speed bypassing `getCanQuickCast`.
- **Validator catch-all gotcha (card-behavior-schema.ts):** `UnknownV2ActionSchema` accepts any action type NOT in `KNOWN_V2_ACTION_TYPES`. Adding a type name to that list WITHOUT also adding an explicit union member makes the catch-all reject it → validation fails. Always add both together (learned adding pump/destroy/bounce/tap/untap).

## Do-Not-Repeat

<!-- Mistakes made and corrected. Each entry prevents the same mistake recurring. -->
<!-- Format: [YYYY-MM-DD] Description of what went wrong and what to do instead. -->

- [2026-05-27] **MTG combat — multiple blockers damage order:** When multiple creatures block a single attacker, it is the **ATTACKER** (not the defender) who assigns damage order among blockers. The defender's declare blockers phase only determines *which* creatures block *which* attacker. Do not show a "stel schade-volgorde in" or damage-ordering UI element on the defender's declare blockers screen.

## Decision Log

<!-- Significant technical decisions with rationale. Why X was chosen over Y. -->
