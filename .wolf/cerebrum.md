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
- **Reusable internal effect helpers:** `draw_card`/`adjust_player_life` RPCs gate on `auth.uid()` so they can't be reused for an arbitrary trigger controller; triggered-ability resolution applies life/draw inline against the payload's `controller_player_id` instead.

## Do-Not-Repeat

<!-- Mistakes made and corrected. Each entry prevents the same mistake recurring. -->
<!-- Format: [YYYY-MM-DD] Description of what went wrong and what to do instead. -->

- [2026-05-27] **MTG combat — multiple blockers damage order:** When multiple creatures block a single attacker, it is the **ATTACKER** (not the defender) who assigns damage order among blockers. The defender's declare blockers phase only determines *which* creatures block *which* attacker. Do not show a "stel schade-volgorde in" or damage-ordering UI element on the defender's declare blockers screen.

## Decision Log

<!-- Significant technical decisions with rationale. Why X was chosen over Y. -->
