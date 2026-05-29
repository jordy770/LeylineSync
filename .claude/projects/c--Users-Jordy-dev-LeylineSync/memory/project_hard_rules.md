---
name: project-hard-rules
description: LeylineSync hard rules that must never be violated — migrations, card scripts, RPC authority
metadata:
  type: feedback
---

These rules are explicitly stated in the design document and must be enforced every session:

1. **Never edit an already-run migration.** Always add a new numbered migration file. Migrations are append-only.

2. **Never generate `cards.script` content from oracle text automatically.** Importing Scryfall data populates metadata only. Card behavior (`script` JSONB) is added deliberately through migrations or an override system, one mechanic at a time. LLMs must not attempt to generate script content from oracle text.

3. **RPCs are the authority for gameplay mutations.** UI submits intents. All gameplay changes go through Supabase RPC functions that check auth, session membership, status, priority, phase, ownership, and payment.

4. **Follow the five-step pattern for new mechanics:** migration with RPC → wrapper in `lib/game/actions.ts` → type in `lib/game/types.ts` → UI in the owning component → runtime state in a `game_*` table if needed.

5. **Do not restructure the schema.** The existing schema has 60+ migrations of working dependencies. The future catalog/behavior/state split is a known cleanup — it is not urgent and must not be done proactively.

**Why:** Validated through extensive design discussion. Stability and correctness over theoretical structural improvements.

**How to apply:** Before writing any code, check this list. Reject any approach that violates these rules.
