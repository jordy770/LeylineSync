# Leyline Sync

Realtime Magic: The Gathering style board/controller app built with Next.js and Supabase.

The app has three main screens:

- `/` session lobby for creating, joining, locking, finishing, and spawning decks.
- `/board/[id]` shared board view.
- `/controller/[id]` player controller view.

The important design choice is that browser UI does not directly mutate critical game state. Most gameplay changes go through Supabase RPC functions, so rules live close to the database rows they protect.

## Tech Stack

- Next.js App Router
- React 19
- Tailwind CSS
- Supabase Auth
- Supabase Postgres
- Supabase Realtime
- Supabase Edge Functions for deck spawning

## Local Setup

Install dependencies:

```powershell
npm install
```

Create `.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL=your-supabase-project-url
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-supabase-publishable-or-anon-key
```

Run the app:

```powershell
npm run dev
```

Useful URLs:

- App: `http://localhost:3000`
- Board: `http://localhost:3000/board/<session-id>`
- Controller: `http://localhost:3000/controller/<session-id>`

Verify before committing:

```powershell
npx tsc --noEmit
npm run lint
npm run build
```

## Project Layout

```text
app/
  board/[id]/page.tsx         Shared board page
  controller/[id]/page.tsx    Player controller page

components/
  GameSessionLobby.tsx        Session list/create/join/spawn controls
  GameBoard.tsx               Battlefield board rendering
  ControllerList.tsx          Player hand/battlefield controls
  ActionButtons.tsx           Executes card script actions
  CardZoneControls.tsx        Plays/casts cards from hand and moves zones
  ManaPool.tsx                Current player's mana pool
  TurnStatusPanel.tsx         Current turn/phase/priority UI
  StackPanel.tsx              Pending stack items
  CombatAssignmentsPanel.tsx  Current combat assignments
  LifeTotalsPanel.tsx         Life totals and manual adjustment

lib/game/
  actions.ts                  Client wrappers around RPCs and Edge Functions
  data.ts                     Client read/query helpers and normalizers
  types.ts                    Shared TypeScript domain types

supabase/
  migrations/                 Database schema, RLS, and RPC rules
  functions/spawn-deck/       Edge Function that creates game_cards from a deck
```

## Runtime Model

Reference card data lives in `cards`. Per-game state lives in `game_*` tables.

### Reference Tables

`cards`

- `id`
- `name`
- `type_line`
- `mana_cost`
- `power`
- `toughness`
- `power_toughness`
- `image_url`
- `script`

`decks`

- `id`
- `list_data`: array of `cards.id` values

### Runtime Tables

`game_sessions`

- `id`
- `status`: `open`, `locked`, `finished`
- `created_by`
- `created_at`
- `locked_at`
- `finished_at`
- `winner_player_id`

`game_session_players`

- `session_id`
- `player_id`
- `seat_number`
- `life_total`
- `joined_at`

`game_cards`

- `id`
- `session_id`
- `card_id`
- `owner_id`
- `zone`: `library`, `hand`, `battlefield`, `graveyard`, `exile`
- `zone_position`
- `is_tapped`
- `damage_marked`
- `position_x`
- `position_y`

`game_players`

- `session_id`
- `player_id`
- `mana_pool`: JSON object with `W`, `U`, `B`, `R`, `G`, `C`

`game_turn_state`

- `session_id`
- `active_player_id`
- `priority_player_id`
- `priority_cycle_started_by`
- `priority_pass_count`
- `lands_played_this_turn`
- `turn_number`
- `phase`
- `step`

`game_combat_assignments`

- `session_id`
- `turn_number`
- `attacker_card_id`
- `attacking_player_id`
- `defending_player_id`
- `blocker_card_id`
- `damage_resolved`

`game_stack_items`

- `session_id`
- `controller_player_id`
- `source_card_id`
- `action_type`
- `payload`
- `position`
- `status`: `pending`, `resolved`, `cancelled`

`game_continuous_effects`

- `session_id`
- `source_card_id`
- `affected_player_id`
- `affected_card_id`
- `effect_type`
- `payload`
- `expires_at_turn_number`
- `expires_at_phase`
- `expires_at_step`

## RPC Pattern

Gameplay writes should be RPCs, not direct client updates.

The usual flow is:

1. UI calls a wrapper in `lib/game/actions.ts`.
2. The wrapper calls `supabase.rpc(...)`.
3. The RPC checks auth, session membership, session status, priority, phase/step, ownership, and payment.
4. The RPC mutates runtime tables.
5. Realtime subscriptions and fallback refresh reload the UI.

Example wrapper:

```ts
export async function castCardFromHand(supabase, sessionId, cardId) {
  const { data, error } = await supabase.rpc('cast_card_from_hand', {
    p_session_id: sessionId,
    p_game_card_id: cardId,
  })

  if (error) throw error
  return data
}
```

When adding a new game action, add:

1. A migration with the RPC.
2. A wrapper in `lib/game/actions.ts`.
3. A type in `lib/game/types.ts` if the return shape is reused.
4. UI in the component that owns that workflow.

## Current RPCs

Session and membership:

- `create_game_session()`
- `join_game_session(session_id)`
- `lock_game_session(session_id)`
- `finish_game_session(session_id)`
- `is_session_player(session_id, player_id)`
- `get_session_players(session_id)`

Cards, zones, mana:

- `set_card_tapped(game_card_id, is_tapped)`
- `move_card_to_zone(game_card_id, zone)`
- `draw_card(session_id, player_id)`
- `untap_all(session_id, player_id)`
- `clear_mana_pool(session_id, player_id)`
- `clear_mana_pool_for_step(session_id, phase, step)`
- `add_mana_from_card(game_card_id, session_id, player_id, color, amount, should_tap_card)`
- `pay_mana_cost(session_id, player_id, mana_cost)`
- `cast_card_from_hand(session_id, game_card_id)`
- `expire_continuous_effects_for_step(session_id, turn_number, phase, step)`
- `create_mana_retention_effect(session_id, source_card_id, colors, affected_player_id, expires_at_phase, expires_at_step, should_tap_card)`

Turn, priority, stack:

- `initialize_turn_state(session_id, active_player_id)`
- `advance_step(session_id)`
- `pass_priority(session_id)`
- `put_action_on_stack(session_id, action_type, payload, source_card_id)`
- `resolve_top_of_stack(session_id)`
- `get_stack_items(session_id)`

Combat and results:

- `declare_attacker(session_id, attacker_card_id, defending_player_id)`
- `declare_blocker(session_id, blocker_card_id, attacker_card_id)`
- `clear_combat_assignments(session_id)`
- `get_combat_assignments(session_id)`
- `get_combat_action_state(session_id)`
- `resolve_combat_damage(session_id)`
- `adjust_player_life(session_id, target_player_id, delta)`
- `maybe_finish_game_session(session_id)`

## Card Scripts

`cards.script` is JSONB metadata that tells the UI which actions to render.

Current supported script actions:

```json
{
  "actions": [
    {
      "type": "add_mana",
      "color": "G",
      "amount": 1
    }
  ],
  "triggers": ["manual_tap"]
}
```

This renders a mana button on a battlefield card. If `manual_tap` is present, the RPC taps the source card when adding mana.

Player damage spell:

```json
{
  "actions": [
    {
      "type": "deal_damage",
      "target": "player",
      "amount": 3
    }
  ]
}
```

If the card has `type_line = 'Instant'`, the UI/RPC treats it as instant timing. If `type_line = 'Sorcery'`, it uses sorcery timing. You can also set timing directly:

```json
{
  "actions": [
    {
      "type": "deal_damage_player",
      "target": "player",
      "amount": 3,
      "timing": "instant"
    }
  ]
}
```

Experimental mana retention action:

```json
{
  "actions": [
    {
      "type": "retain_mana",
      "colors": ["G"],
      "expires_at_phase": "ending",
      "expires_at_step": "cleanup"
    }
  ],
  "triggers": ["manual_tap"]
}
```

This creates a `mana_does_not_empty` continuous effect for the current player. With `manual_tap`, the source card taps when the effect is created. The card must be on the battlefield and the controller must have priority.

This action exists as infrastructure, but real mana-retention cards are intentionally parked for now. Many of those cards have subtle timing, replacement, duration, and mana-spending rules, so they should be implemented later per card or per mechanic after the core game loop is more stable.

## Mana And Casting

`cards.mana_cost` stores simple costs such as:

```text
{G}
{1}
{2}{G}
{R}
```

Current mana payment behavior:

- Colored costs require that exact color.
- Generic costs are paid from available mana in order: `C`, `W`, `U`, `B`, `R`, `G`.
- Hybrid, Phyrexian, X, reducers, taxes, alternate costs, and cost increases are not modeled yet.

Priority improvement:

- Let players choose which colored/colorless mana pays generic costs.
- The current automatic order is acceptable for early testing, but it can spend a color the player wanted to keep.
- This should be handled before deeper casting work, because permanent spells through stack will make payment choices more visible.

Current mana clearing behavior:

- Mana automatically clears when `advance_step` leaves the current step.
- Clearing applies to existing `game_players.mana_pool` rows.
- By default, every color in `W`, `U`, `B`, `R`, `G`, and `C` goes to `0`.
- Effects can preserve specific colors through `game_continuous_effects`.
- Real card implementations that create mana-retention effects are deferred.

Mana retention effect:

```json
{
  "effect_type": "mana_does_not_empty",
  "affected_player_id": "player uuid or null for all players",
  "payload": {
    "colors": ["G", "C"]
  },
  "expires_at_phase": "ending",
  "expires_at_step": "cleanup"
}
```

`clear_mana_pool_for_step` reads those active effects. If `colors` contains `G`, green mana is kept when the step advances while the other colors are cleared. After clearing, `advance_step` calls `expire_continuous_effects_for_step`, so step-scoped effects still apply to the step they expire on.

Current land behavior:

- Lands are played from hand through `cast_card_from_hand`.
- A player can play one land per turn.
- Lands require active player, main phase, priority, and empty stack.
- Basic lands can use `add_mana` scripts on battlefield.

Current nonland permanent behavior:

- Non-Instant/Sorcery cards can be cast from hand through `cast_card_from_hand`.
- The RPC pays `cards.mana_cost`.
- The card moves to battlefield.
- This is intentionally simplified and does not use the stack yet for permanent spells.

Current Instant/Sorcery behavior:

- The card is cast through its `ActionButtons` spell action.
- Mana cost is paid if the source card is in hand.
- A `game_stack_items` row is created.
- The source card moves from hand to graveyard.
- When all players pass priority, the top stack item resolves.

## Turn And Priority

`active_player_id` and `priority_player_id` are separate:

```text
active_player_id = whose turn it is
priority_player_id = who is allowed to act now
```

`advance_step` controls phase progression:

- Untap step untaps active player's battlefield.
- Draw step draws one card.
- Cleanup advances to the next seat and resets `lands_played_this_turn`.
- Combat assignments are cleared around combat cleanup points.
- Marked damage is cleared during Cleanup Step.

`pass_priority` controls priority:

1. Current priority player passes.
2. Priority moves to the next player by `seat_number`.
3. If all players pass:
   - resolve top stack item if stack is not empty
   - otherwise advance the step

This is a practical approximation. Later, APNAP edge cases and windows around every special action can be made more precise.

## Combat

Current combat support:

- Active player declares attackers during Declare Attackers Step.
- Declaring an attacker taps it.
- Defending priority player declares blockers during Declare Blockers Step.
- Blockers do not tap.
- One blocker per attacker is supported.
- Combat damage is resolved manually during Combat Damage Step.
- Unblocked attackers damage defending player.
- Blocked attackers mark damage on blockers.
- Blockers mark damage back on attackers.
- Creatures with lethal marked damage move to graveyard.
- Marked damage clears during Cleanup Step.

Current limitations:

- No trample.
- No first strike/double strike.
- No vigilance.
- No summoning sickness.
- No protection/prevention/replacement effects.
- No multiple blockers.
- No planeswalker/battle targets.

## Realtime

The UI subscribes to runtime tables and also uses short fallback refresh intervals.

Realtime tables currently used:

- `game_cards`
- `cards`
- `game_players`
- `game_turn_state`
- `game_session_players`
- `game_sessions`
- `game_combat_assignments`
- `game_stack_items`
- `game_continuous_effects`

Add tables to Supabase Realtime when needed:

```sql
alter publication supabase_realtime add table public.game_cards;
alter publication supabase_realtime add table public.game_players;
alter publication supabase_realtime add table public.game_turn_state;
alter publication supabase_realtime add table public.game_session_players;
alter publication supabase_realtime add table public.game_stack_items;
alter publication supabase_realtime add table public.game_continuous_effects;
```

If a table is already in the publication, Supabase can return an error. That is fine.

## Edge Function: spawn-deck

The deck spawning function lives at:

```text
supabase/functions/spawn-deck/index.ts
```

It:

- checks the authenticated user
- checks session membership
- rejects duplicate deck spawning for the same player/session
- reads `decks.list_data`
- inserts card instances into `game_cards`

Check locally:

```powershell
deno check --config "supabase/functions/spawn-deck/deno.json" "supabase/functions/spawn-deck/index.ts"
```

Deploy:

```powershell
supabase functions deploy spawn-deck
```

## Migrations

Run migrations in order. Current migration list:

```text
202605010000_move_card_to_zone.sql
202605010001_add_mana_from_card.sql
202605010002_draw_card.sql
202605010003_untap_all.sql
202605010004_clear_mana_pool.sql
202605010005_turn_state.sql
202605010006_advance_step.sql
202605010007_advance_step_untap.sql
202605010008_advance_step_draw.sql
202605010009_game_sessions.sql
202605010010_session_membership_hardening.sql
202605010011_finish_game_session.sql
202605010012_session_read_policies.sql
202605010013_session_player_usernames.sql
202605010014_turn_rotation.sql
202605010015_turn_state_realtime.sql
202605010016_adjust_player_life.sql
202605010017_combat_declarations.sql
202605010018_combat_action_state.sql
202605010019_combat_blockers.sql
202605010020_turn_priority_player.sql
202605010021_blockers_do_not_tap.sql
202605010022_resolve_combat_damage.sql
202605010023_parse_power_toughness.sql
202605010024_win_loss_state.sql
202605010025_blocked_attacker_damage.sql
202605010026_lethal_damage_to_graveyard.sql
202605010027_blocker_damage_to_attackers.sql
202605010028_runtime_state_rls.sql
202605010029_priority_passing.sql
202605010030_stack_action_layer.sql
202605010031_stack_action_timing.sql
202605010032_stack_item_display_details.sql
202605010033_stack_item_player_name_fallback.sql
202605010034_mana_cost_and_casting.sql
202605010035_fix_cast_card_from_hand_row_select.sql
202605010036_land_play_limit.sql
202605010037_effect_aware_mana_clearing.sql
202605010038_mana_retention_action.sql
```

## Adding New Card Mechanics

Use the smallest server-side rule you can.

For a new activated ability:

1. Add a script action in `cards.script`.
2. Add UI handling in `ActionButtons.tsx`.
3. Add or extend an RPC in a migration.
4. Add a wrapper in `lib/game/actions.ts`.
5. Store any temporary state in a `game_*` runtime table.

For a new static or continuous effect, prefer a table instead of hardcoding flags everywhere:

```text
game_continuous_effects
- id
- session_id
- source_card_id
- affected_player_id nullable
- affected_card_id nullable
- effect_type
- payload
- expires_at_phase nullable
- expires_at_step nullable
- expires_at_turn_number nullable
- created_at
```

Example: mana does not empty

```json
{
  "effect_type": "mana_does_not_empty",
  "payload": {
    "colors": ["G"]
  },
  "expires_at_step": "cleanup"
}
```

Mana retention is already wired into automatic mana clearing. The generic card action/RPC exists, but actual real-card support is parked because these cards tend to need precise custom rules. When this is picked up again, implement one concrete card or one narrow mechanic at a time and let it insert a `game_continuous_effects` row.

Example: indestructible

Recommended model:

```json
{
  "effect_type": "indestructible",
  "affected_card_id": "game_card_id",
  "payload": {}
}
```

Where to apply it:

- In the lethal-damage-to-graveyard part of `resolve_combat_damage`.
- Before moving a creature with lethal damage to graveyard, check active `indestructible` effects.
- If present, keep the card on battlefield with marked damage until cleanup.

Example: trample

Recommended model:

```json
{
  "effect_type": "trample",
  "affected_card_id": "attacker_game_card_id",
  "payload": {}
}
```

Where to apply it:

- In `resolve_combat_damage`.
- For a blocked attacker with trample, compute lethal damage needed for the blocker.
- Assign excess damage to defending player.
- Keep the first implementation simple: one blocker only, no damage assignment choices.

Example: vigilance

Recommended model:

```json
{
  "effect_type": "vigilance",
  "affected_card_id": "attacker_game_card_id",
  "payload": {}
}
```

Where to apply it:

- In `declare_attacker`.
- If the attacker has vigilance, do not tap it.

## Development Rules Of Thumb

- Put irreversible or rules-critical changes in RPCs.
- Keep card metadata in `cards`; keep match state in `game_*`.
- Keep UI permissive enough to show useful controls, but trust RPCs as final authority.
- Prefer adding a migration over editing an old already-run migration.
- Keep new mechanics narrow. Build one effect type, one rule hook, and one UI surface at a time.
- After changing TypeScript, run `npx tsc --noEmit` and `npm run lint`.
- After changing SQL, run the new migration against Supabase and test the actual action in the UI.

## Finished Game Data Retention

Do not hard-delete runtime data immediately when a game finishes. The UI still needs enough data to show the final state, winner, final life totals, and debugging context.

Keep long-term:

- `game_sessions`
- `game_session_players`
- later: compact match history or `game_results`

Clean up later:

- `game_cards`
- `game_combat_assignments`
- `game_turn_state`
- `game_stack_items`
- temporary effect/token tables

Future cleanup should be an explicit RPC or scheduled job, not part of `maybe_finish_game_session`.

## Roadmap

Done:

- [x] Authenticated sessions and session membership
- [x] Deck spawning per session/player
- [x] Board and controller views
- [x] Zones and manual zone movement
- [x] Mana pool display
- [x] Basic mana generation from scripted cards
- [x] Turn, phase, and step state
- [x] Automatic untap and draw steps
- [x] Active player rotation
- [x] Life totals and win/loss state
- [x] Attackers, blockers, and combat assignment UI
- [x] Combat damage to players and creatures
- [x] Lethal damage to graveyard
- [x] Priority passing
- [x] Basic stack model
- [x] Instant/Sorcery damage actions through stack
- [x] Mana costs and first casting flow
- [x] Basic lands and one-land-per-turn rule
- [x] Automatic mana clearing with effect-aware retention
- [x] Infrastructure for mana retention effects

High-value next work:

- [ ] Player-chosen payment for generic mana costs
- [ ] Permanent spells through stack instead of direct battlefield movement
- [ ] Land play UI state that shows remaining land plays
- [ ] Real card implementations for mana-retention effects, parked until later
- [ ] Summoning sickness
- [ ] Vigilance
- [ ] Trample
- [ ] Indestructible
- [ ] Multiple blockers and damage assignment
- [ ] First strike / double strike
- [ ] Cleanup hand-size discard
- [ ] Token creation
- [ ] Better card script schema validation
- [ ] Scheduled cleanup for old finished game runtime data

## Known Caveats

- Permanent spells currently move directly from hand to battlefield after paying mana.
- Instant/Sorcery cards move from hand to graveyard when put on the stack. A dedicated `stack` card zone can be added later for counterspells and cancellation.
- Mana cost parsing is intentionally simple.
- Priority is good enough for early stack work, but not a full rules-engine implementation.
- Public `cards` metadata is treated as shared reference data. If hidden decklists or private collections matter later, add separate RLS boundaries.
- Next build may warn about another `package-lock.json` at `C:\Users\jordy\package-lock.json`; the build can still succeed. Configure `turbopack.root` or remove the unrelated parent lockfile to silence it.
