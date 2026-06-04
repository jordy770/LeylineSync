---
name: project-architecture
description: LeylineSync core architectural principles — RPCs, reference vs runtime data, continuous effects, RLS
metadata:
  type: project
---

**Architectural principles (validated by existing codebase, should be preserved):**

- **RPCs are authoritative.** All gameplay mutations go through Supabase RPCs. UI does not directly mutate critical game state.

- **Reference data is separate from runtime data.** `cards` = catalog/reference (name, mana cost, oracle text, image URL, script). `game_*` tables = per-game state (zones, controllers, taps, counters, mana pools, turn state, stack, combat, continuous effects).

- **Continuous effects live in `game_continuous_effects` table, not as hardcoded flags.** Rows define source card, source zone requirement, affected player/card, effect type, payload, and expiry. `rebuild_scripted_continuous_effects` can regenerate them from scratch.

- **Hidden information enforced by RLS.** Players only see their own hand and library. Battlefield/graveyard/exile/stack visible to all. Realtime subscriptions respect RLS.

**Three layers of card data (keep conceptually distinct):**
1. **Catalog** — Scryfall-sourced metadata. Refreshable. Never hand-edited.
2. **Behavior** — `script` JSONB defining gameplay rules. Hand-authored or migration-applied. Versioned with status field (`unsupported`, `generated`, `verified`, `broken`, `manual`).
3. **Game state** — per-instance `game_cards` rows. Two copies of the same card = two separate rows.

**Current schema caveat:** Cards are keyed by Scryfall printing ID, not oracle ID. Works fine but a future cleanup to `cards_catalog` + `card_printings` + `card_behaviors` is acknowledged. Not urgent.

**Why:** Sound design validated through 60+ migrations of working code.

**How to apply:** When reading schema or adding features, respect these separation boundaries.
