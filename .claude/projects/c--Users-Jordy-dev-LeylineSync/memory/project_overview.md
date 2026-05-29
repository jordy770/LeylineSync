---
name: project-overview
description: LeylineSync project overview — two-screen MTG rules engine built with Next.js and Supabase Realtime
metadata:
  type: project
---

LeylineSync is a full MTG rules engine app (not just a tracker) with a two-screen architecture:

- **Mobile controller** (`/controller/[id]`) — each player's phone; private actions (hand, attackers, mana, priority responses)
- **Shared big screen** (`/board/[id]`) — playmat for all players; battlefield, stack, animations, Scryfall art

Synchronized via Supabase Realtime. Card art from Scryfall API.

Other screens: `/` (session lobby), `/decks` (deck manager).

**Stack:** Next.js App Router, React 19, Tailwind CSS, Supabase Auth/Postgres/Realtime, Supabase Edge Functions (deck spawning).

**Why:** RPC-first design — browser UI submits intents; Supabase RPCs validate and apply game state. Rules live close to the database rows they protect.

**How to apply:** When adding any gameplay feature, follow the five-step pattern: migration with RPC → wrapper in `lib/game/actions.ts` → type in `lib/game/types.ts` → UI in owning component → runtime state in a `game_*` table if needed.
