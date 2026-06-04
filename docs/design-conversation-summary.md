# LeylineSync Design Conversation Summary

Context document capturing architectural discussion and decisions about the LeylineSync MTG companion/rules app. Intended as background reading for Claude Code sessions so the reasoning behind current choices is preserved.

## Project Overview

LeylineSync is a Magic: The Gathering app with a two-screen architecture:

- **Mobile controller** — each player's phone, used for private actions (viewing hand, declaring attackers, paying mana, responding to priority).
- **Shared big screen** — a single display showing the playmat for all players, where the battlefield, stack, and animations live.

The two screens are synchronized via Supabase Realtime. The app is intended to be a **full rules engine**, not just a tracker — it enforces MTG rules rather than relying on players to do so.

Card art comes from the Scryfall API. The shared big screen is the visual canvas (where Scryfall art and animations live); the mobile controller is a dense functional control surface.

## Styling Direction

The styling discussion landed on a split visual language between the two screens:

**Mobile controller** — utilitarian, dark warm base (around `#0F1117` with off-white text `#E8E4D8`), minimal decorative chrome, large tap targets. Mana colors used only as functional accents where informationally meaningful, not as decoration. Serif typography reserved for hero moments (life total, active phase) so the MTG flavor is present without slowing play. Phone is a "control surface" — think DJ deck or fighting game HUD.

**Big screen playmat** — atmospheric, immersive, where the spectacle lives. Full-bleed Scryfall art, dynamic lighting tied to game state, smooth animations. Player zones at the edges with very large serif life totals readable from across a table. The frame supports the art; it doesn't compete with it.

**Mobile UI structure** — phase-specific layouts rather than one cluttered universal layout. Each phase shows only what matters right now:
- Declare attackers: drag-line targeting from creatures to defending players/planeswalkers
- Main phase: hand + battlefield interaction
- Priority/response windows: prominent but non-blocking, with a Pass/Respond choice
- Mana: six-part quick-add (W/U/B/R/G/C) with a slide-right expansion to a full mana overview including utility lands with previews

Suggested fonts: Cinzel or Cormorant from Google Fonts as Beleren-adjacent serifs (Beleren itself isn't free for commercial use). Mana symbol font: Andrew Gioia's free Mana font.

## Architectural Principles (Validated by Existing Codebase)

These are correct decisions already implemented and should be preserved:

1. **RPCs are authoritative.** Browser UI does not directly mutate critical game state. All gameplay changes go through Supabase RPC functions that check auth, session membership, session status, priority, phase/step, ownership, and payment. UI submits intents; the database validates and applies.

2. **Reference data is separate from runtime data.** `cards` holds catalog/reference info (name, mana cost, oracle text, image URL, script). `game_*` tables hold per-game state (zones, controllers, taps, counters, mana pools, turn state, stack, combat assignments, continuous effects).

3. **Continuous effects live in a table, not as hardcoded flags.** `game_continuous_effects` rows define source card, source zone requirement, affected player/card, effect type, payload, and expiry. Effects are derived runtime state — the source of truth is the current `game_cards` row, and `rebuild_scripted_continuous_effects` can regenerate them from scratch. This handles copy effects, control changes, and zone-move lifecycle cleanly.

4. **Migrations are append-only.** Never edit a migration that has already run. Always add a new one.

5. **Card scripts are never auto-generated from oracle text.** Importing Scryfall data populates metadata only. Gameplay behavior in `cards.script` is added deliberately through migrations or an override system, one mechanic at a time. This is a hard rule — LLMs (including Claude Code) should not attempt to generate `script` content from oracle text.

6. **Hidden information is enforced by RLS.** Postgres row-level security ensures players only see their own hand and library, while battlefield/graveyard/exile/stack are visible to all. Realtime subscriptions respect RLS.

## The Three Layers of Card Data

Worth keeping conceptually distinct even though they currently overlap in the schema:

- **Catalog** — Scryfall-sourced metadata about every unique card. Refreshable from bulk data. Should not be hand-edited.
- **Behavior** — the `script` JSONB defining gameplay rules. Hand-authored or migration-applied. Versioned, status-tracked, never overwritten by Scryfall sync.
- **Game state** — per-instance, per-game rows in `game_cards` and related tables. Each instance has its own zone, controller, tap state, counters, etc. Two copies of the same card in one game are two separate `game_cards` rows.

The current schema keys cards by Scryfall printing ID rather than oracle ID. The importer deduplicates to one print per oracle_id, so functionally this works, but eventually splitting `cards_catalog` + `card_printings` + `card_behaviors` would be cleaner. **This is a future cleanup, not an urgent refactor.** The existing schema works and has 61 migrations of dependencies — restructuring it would be costly and is not justified by current needs.

## Card Script Schema (Current State)

The `cards.script` JSONB is intentionally simple. Known limitations to be aware of:

- `triggers: ["cast"]` on instants/sorceries conflates "trigger" with "spell resolution effect" — functionally works but is structurally imprecise. Treat as practical approximation, not as accurate rules model.
- `manual_tap` for mana producers doesn't fully model mana abilities (which don't use the stack and can be activated during spell casting). The current implementation works for basic cases.
- Keyword abilities are partially in `keywords` (from Scryfall) and partially in `script.continuous_effects`. The script side is the rules-engine source of truth; the keywords field is for search/display.

**Important:** before adding many new card scripts, getting Zod or JSON Schema validation in place for the script field would catch typo bugs and hallucinated field names early. This is high-leverage work and a good early Claude Code session.

## Engine Concepts Currently Implemented

- Sessions, membership, locking, finishing, win/loss state
- Deck import from text, deck editor, randomized library spawn via Edge Function
- Zones (library, hand, stack, battlefield, graveyard, exile) with manual and rule-driven movement
- Mana pool with player-chosen generic payment and effect-aware clearing
- Turn structure with phases and steps, active player rotation, automatic untap and draw
- Priority passing with stack resolution and step advancement
- Stack model with cast spells, counterspell cancellation, permanent spells using the stack
- Combat: declare attackers, declare blockers, multiple blockers with ordered damage, lethal-damage-to-graveyard
- Keywords with rules effects: flying not yet, but vigilance, trample, indestructible, first strike, double strike, haste are wired in
- Summoning sickness
- Continuous effects: additional land plays (Exploration, Azusa), mana retention infrastructure (Upwelling/Omnath data exists; full rules are deferred)
- Static-effect lifecycle rebuild for copies, control changes, suppression
- Dev admin panel behind `NEXT_PUBLIC_SHOW_DEV_CONTROLS=true`

## High-Value Next Work (from the existing roadmap)

- Script schema validation (Zod or JSON Schema for `cards.script`)
- Flying and reach for blocker legality
- +1/+1 counters
- Until-end-of-turn power/toughness effects
- Token creation
- Cleanup-step hand-size discard
- Player-chosen combat damage over-assignment
- A card script override system separate from imported Scryfall metadata

## LLM-Assisted Card Generation (Future Work)

When card behavior generation eventually becomes LLM-assisted at scale, the constraints are:

- LLMs are confidently wrong about MTG rules. Output must be validated against a strict schema and tested against canonical scenarios.
- Always pass current Scryfall oracle text in the prompt rather than relying on LLM memory of card text.
- Use a status field (`unsupported`, `generated`, `verified`, `broken`, `manual`) so games can filter to verified-only card pools.
- Generate in small batches of similar mechanical type, with hand-written examples as few-shot prompts.
- Maintain a known-hard-cards list of cards that should never be LLM-generated (Humility, Opalescence, Mindslaver, anything with restart-the-game, anything with "as ~ enters" choices, anything with split cards or modal double-faced layouts).
- Do not auto-generate from oracle text into the production `cards.script` column. Use a separate override or staging system.

## Stack and Priority Design

The current approximation passes priority sequentially by seat number with all-pass triggering resolution or step advancement. This is good enough for early development but not full APNAP correctness.

When refining, the "broadcast event" model is the right framing: priority is not a blocking modal but a non-blocking notification on each opponent's phone with Pass/Respond as the choice. Big screen shows the visual stack with cards floating in the center, animating off the top on resolution. Mobile shows a slim vertical strip with stack contents, tap-to-expand for full card view.

Triggered abilities are a candidate for "automatically detect potential triggers from card text, prompt controller to confirm" — trains players to think about triggers without punishing them for forgetting.

## Working with Claude Code on This Project

Patterns that work well:

- Start each session with orientation: "Read CLAUDE.md, then read the files relevant to what we're about to do."
- Describe work at a mid-level of abstraction: enough context that the tool can plan, not so much that it removes the value of having a capable assistant.
- Ask for a plan before changes: "Show me your plan before making changes." Catch wrong assumptions cheap.
- Verify with the standard commands after every change: `npx tsc --noEmit`, `npm run lint`, `npm run build`. Run new migrations against local Supabase. Test the actual mechanic in the UI.
- Commit before every session and after every meaningful change. Treat sessions like feature branches.
- One mechanic per session. Don't sprawl across multiple unrelated changes.
- When things go sideways, `git reset` and start over with better context rather than trying to debug confused state.

Hard rules to enforce in CLAUDE.md:

- Never edit an already-run migration. Always add a new one.
- Never generate `cards.script` content from oracle text automatically.
- Follow the existing five-step pattern for new mechanics: migration with RPC, wrapper in `lib/game/actions.ts`, type in `lib/game/types.ts`, UI in the owning component, runtime state in a `game_*` table if needed.
- RPCs are the authority for gameplay mutations. UI submits intents.

## What Was Reconsidered During This Conversation

Earlier in the discussion, before the codebase was visible, advice was given to split the `cards` table into separate catalog/behavior tables, refactor the script schema to v2, and consider starting fresh. After reading the actual repository, this advice was retracted. The existing architecture is sound, the schema has acceptable trade-offs given current scope, and 61 migrations of working code should not be thrown away over theoretical structural improvements. Future cleanups are possible but not urgent. Build forward, don't restructure backward.
