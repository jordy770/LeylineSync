---
name: project-roadmap
description: LeylineSync implemented features and high-value next work items as of 2026-05-27
metadata:
  type: project
---

**Currently implemented (as of 2026-05-27):**
- Sessions, membership, locking, finishing, win/loss state
- Deck import from text, deck editor, randomized library spawn (Edge Function)
- Zones (library, hand, stack, battlefield, graveyard, exile) with manual and rule-driven movement
- Mana pool with player-chosen generic payment and effect-aware clearing
- Turn structure: phases, steps, active player rotation, automatic untap and draw
- Priority passing with stack resolution and step advancement
- Stack model: cast spells, counterspell cancellation, permanent spells using the stack
- Combat: declare attackers/blockers, multiple blockers with ordered damage, lethal-damage-to-graveyard
- Keywords: vigilance, trample, indestructible, first strike, double strike, haste (flying not yet)
- Summoning sickness
- Continuous effects: additional land plays; mana retention infrastructure (deferred full rules)
- Static-effect lifecycle rebuild for copies, control changes, suppression
- Dev admin panel (`NEXT_PUBLIC_SHOW_DEV_CONTROLS=true`)

**High-value next work (prioritized):**
1. Script schema validation — Zod or JSON Schema for `cards.script` (high-leverage, catch typo/hallucination bugs early)
2. Flying and reach — blocker legality
3. +1/+1 counters
4. Until-end-of-turn power/toughness effects
5. Token creation
6. Cleanup-step hand-size discard
7. Player-chosen combat damage over-assignment
8. Card script override system separate from Scryfall metadata

**Why:** Roadmap from design conversation with the project owner, 2026-05-27.

**How to apply:** Suggest next work items from this list when the user asks what to work on. Script schema validation is the highest-leverage item to do before scaling card behaviors.
