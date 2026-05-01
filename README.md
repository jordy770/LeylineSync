# Leyline Sync

Realtime Magic: The Gathering board/controller app built with Next.js and Supabase.

The current goal is a shared board screen plus a player controller screen. A deck can be spawned into `game_cards`, the board shows live card state, and controller buttons execute scripted card actions such as Llanowar Elves adding green mana.

## Stack

- Next.js app router
- React 19
- Tailwind CSS
- Supabase Auth, Database, Realtime, and Edge Functions

## Clone And Run

Install dependencies:

```powershell
npm install
```

Create `.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL=your-supabase-project-url
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-supabase-publishable-or-anon-key
```

Run the dev server:

```powershell
npm run dev
```

Open:

- App: `http://localhost:3000`
- Board view: `http://localhost:3000/board/<session-id>`
- Controller view: `http://localhost:3000/controller/<session-id>`

## Build And Verify

Use these before committing or deploying:

```powershell
npx tsc --noEmit
npm run lint
npm run build
```

Start a production build locally:

```powershell
npm run start
```

## Supabase Edge Function

The deck spawning function lives at:

```text
supabase/functions/spawn-deck/index.ts
```

Check it locally with Deno:

```powershell
deno check --config "supabase/functions/spawn-deck/deno.json" "supabase/functions/spawn-deck/index.ts"
```

Deploy it:

```powershell
supabase functions deploy spawn-deck
```

Call it with:

```powershell
curl -i --location --request POST "https://<PROJECT_REF>.supabase.co/functions/v1/spawn-deck" `
  --header "Authorization: Bearer <USER_ACCESS_TOKEN>" `
  --header "Content-Type: application/json" `
  --data "{""sessionId"":""..."",""deckId"":""...""}"
```

## Expected Database Shape

The app currently expects these tables/columns.

`cards`:

- `id`
- `name`
- `script`
- `type_line`
- `image_url`

`decks`:

- `id`
- `list_data`, an array of card ids

`game_cards`:

- `id`
- `session_id`
- `card_id`
- `owner_id`
- `zone`
- `zone_position`
- `is_tapped`
- `position_x`
- `position_y`

`game_players`:

- `session_id`
- `player_id`
- `mana_pool`

`game_turn_state`:

- `session_id`
- `active_player_id`
- `turn_number`
- `phase`
- `step`
- `created_at`
- `updated_at`

`game_sessions`:

- `id`
- `status`
- `created_by`
- `created_at`
- `locked_at`
- `finished_at`

`game_session_players`:

- `session_id`
- `player_id`
- `seat_number`
- `life_total`
- `joined_at`

Add the image column if it does not exist yet:

```sql
alter table public.cards
add column if not exists image_url text;
```

## RLS Policies Needed

The browser client needs to read card metadata:

```sql
create policy "Authenticated users can read cards"
on public.cards
for select
to authenticated
using (true);
```

Players need to manage their own player state:

```sql
create policy "Players can read their own player state"
on public.game_players
for select
to authenticated
using (player_id = auth.uid());

create policy "Players can create their own player state"
on public.game_players
for insert
to authenticated
with check (player_id = auth.uid());

create policy "Players can update their own player state"
on public.game_players
for update
to authenticated
using (player_id = auth.uid())
with check (player_id = auth.uid());
```

Depending on your existing policies, `game_cards` also needs authenticated read/update access for the relevant session/player.

## RPC Functions

The app expects these database functions for server-side game actions:

- `public.move_card_to_zone(uuid, text)`
- `public.add_mana_from_card(uuid, uuid, uuid, text, integer, boolean)`
- `public.draw_card(uuid, uuid)`
- `public.untap_all(uuid, uuid)`
- `public.clear_mana_pool(uuid, uuid)`
- `public.initialize_turn_state(uuid, uuid)`
- `public.advance_step(uuid)`
- `public.is_session_player(uuid, uuid)`
- `public.create_game_session()`
- `public.join_game_session(uuid)`
- `public.lock_game_session(uuid)`
- `public.finish_game_session(uuid)`
- `public.get_session_players(uuid)`
- `public.adjust_player_life(uuid, uuid, integer)`
- `public.declare_attacker(uuid, uuid, uuid)`
- `public.declare_blocker(uuid, uuid, uuid)`
- `public.clear_combat_assignments(uuid)`
- `public.get_combat_assignments(uuid)`
- `public.get_combat_action_state(uuid)`

The migrations live at:

```text
supabase/migrations/202605010000_move_card_to_zone.sql
supabase/migrations/202605010001_add_mana_from_card.sql
supabase/migrations/202605010002_draw_card.sql
supabase/migrations/202605010003_untap_all.sql
supabase/migrations/202605010004_clear_mana_pool.sql
supabase/migrations/202605010005_turn_state.sql
supabase/migrations/202605010006_advance_step.sql
supabase/migrations/202605010007_advance_step_untap.sql
supabase/migrations/202605010008_advance_step_draw.sql
supabase/migrations/202605010009_game_sessions.sql
supabase/migrations/202605010010_session_membership_hardening.sql
supabase/migrations/202605010011_finish_game_session.sql
supabase/migrations/202605010012_session_read_policies.sql
supabase/migrations/202605010013_session_player_usernames.sql
supabase/migrations/202605010014_turn_rotation.sql
supabase/migrations/202605010015_turn_state_realtime.sql
supabase/migrations/202605010016_adjust_player_life.sql
supabase/migrations/202605010017_combat_declarations.sql
supabase/migrations/202605010018_combat_action_state.sql
supabase/migrations/202605010019_combat_blockers.sql
supabase/migrations/202605010020_turn_priority_player.sql
supabase/migrations/202605010021_blockers_do_not_tap.sql
```

## Realtime

The board and controller subscribe to `game_cards` and `cards`. A 2 second fallback refresh is also in place.

Enable Supabase Realtime for the relevant tables:

```sql
alter publication supabase_realtime add table public.game_cards;
alter publication supabase_realtime add table public.cards;
alter publication supabase_realtime add table public.game_players;
alter publication supabase_realtime add table public.game_turn_state;
alter publication supabase_realtime add table public.game_session_players;
```

If a table is already in the publication, Supabase may return an error. That is fine.

## Current App State

Implemented:

- `/board/[id]` renders the shared board for a session.
- `/controller/[id]` renders the player controller for a session.
- `spawn-deck` Edge Function reads `decks.list_data` and inserts rows into `game_cards`.
- `GameBoard` fetches `game_cards`, joins card metadata manually by `card_id`, and renders `cards.image_url` when present.
- `ControllerList` fetches the current authenticated player, loads only their `game_cards`, joins card metadata manually, and renders controls.
- `CardController` can tap/untap a card.
- `LifeTotalsPanel` shows session player life totals and can adjust life by 1 or 5.
- `CombatAssignmentsPanel` shows declared attackers for the current combat.
- Controller battlefield cards can be declared as attackers during Declare Attackers Step.
- `ActionButtons` reads `cards.script` and supports:
  - `type: "add_mana"`
  - `triggers: ["manual_tap"]`
- Llanowar Elves script example:

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

Known next steps:

- Add/fill `cards.image_url` values.
- Confirm RLS policies for `cards`, `game_cards`, and `game_players`.
- Add a visible mana pool UI so mana changes can be seen immediately.
- Decide how zones should work: library, hand, battlefield, graveyard, exile.
- Move more MTG script effects into typed executors: draw card, move zone, create token, deal damage.
- Consider moving action execution into an Edge Function or RPC for safer server-side rules.

## Turn And Phase Roadmap

Do not automate all Magic rules at once. First store the current turn/phase/step, then attach small server-side actions to step transitions.

Recommended order:

1. Add `clear_mana_pool` RPC.
2. Add turn state in a dedicated `game_turn_state` table:
   - `session_id`
   - `active_player_id`
   - `turn_number`
   - `phase`
   - `step`
3. Add typed phase/step values in the app.
4. Add `advance_step` RPC.
5. Show current active player, turn number, phase, and step in the board/controller UI.

MTG phase structure to model:

- Beginning Phase
  - Untap Step
  - Upkeep Step
  - Draw Step
- Main Phase 1
- Combat Phase
  - Beginning of Combat Step
  - Declare Attackers Step
  - Declare Blockers Step
  - Combat Damage Step
  - End of Combat Step
- Main Phase 2
- Ending Phase
  - End Step
  - Cleanup Step

Later `advance_step` can call small RPCs automatically:

- battlefield cards are untapped automatically when advancing from Untap Step to Upkeep Step
- one card is drawn automatically when advancing from Draw Step to Main Phase 1
- active player rotates to the next session seat when advancing from Cleanup Step to Untap Step
- player life totals can be changed through `adjust_player_life`
- `clear_mana_pool` when leaving phases where mana should empty
- cleanup/discard logic during Cleanup Step

Mana clearing should become effect-aware before it is fully automated. Some cards allow mana to stay in a player's mana pool longer than normal, so `clear_mana_pool` should eventually preserve mana covered by active effects instead of always resetting every color to zero.

Likely future model:

```text
game_continuous_effects
- id
- session_id
- player_id
- source_card_id
- effect_type
- payload
- expires_at_step
- created_at
```

Example retention effect:

```json
{
  "effect_type": "mana_does_not_empty",
  "payload": {
    "colors": ["G"]
  },
  "expires_at_step": "cleanup"
}
```

Future `clear_mana_pool` behavior:

1. Load the player's current `mana_pool`.
2. Load active mana-retention effects for that player/session.
3. Clear only mana that is not protected by those effects.
4. Keep retained mana until the effect expires.

Until this is implemented, automatic mana clearing in `advance_step` should be added carefully and documented as not supporting special mana-retention cards yet.

## Multiplayer And Session Roadmap

Before building combat, damage, and win conditions, harden multiplayer sessions. Combat depends on reliable player membership, active-player rotation, and life totals.

Recommended next slice:

1. Add `game_sessions`.
2. Add `game_session_players`.
3. Add RPCs for creating, joining, and locking a session.
4. Update game RPCs to reject actions from users who are not members of the session.
5. Add active-player switching at end of turn.

First implemented slice:

- homepage lobby for creating and joining sessions
- homepage shows sessions where the current user is a player
- homepage deck spawn by deck id
- `game_sessions`
- `game_session_players`
- `create_game_session`
- `join_game_session`
- `lock_game_session`
- `finish_game_session`
- session creator is automatically seat 1
- joined players receive the next available seat number
- session seats show `profiles.username` with id fallback instead of only ids
- turn rotation uses `game_session_players.seat_number`
- turn state uses realtime plus a short fallback refresh so the next active player updates
- life totals use `game_session_players.life_total` with realtime plus fallback refresh
- locked sessions cannot be joined
- session creator can finish the session
- `spawn-deck` derives the owner from the authenticated user token
- `spawn-deck` rejects users who are not members of the session
- `spawn-deck` rejects spawning a second deck for the same player/session
- `advance_step` rejects users who are not members of the session

Suggested database shape:

```text
game_sessions
- id
- status: open | locked | finished
- created_by
- created_at
- locked_at
- finished_at
```

```text
game_session_players
- session_id
- player_id
- seat_number
- life_total
- joined_at
```

Suggested RPCs:

- `create_game_session()`
- `join_game_session(session_id)`
- `lock_game_session(session_id)`

After this is in place, combat/damage can build on stable multiplayer state:

- attackers/blockers
- life total changes
- damage assignment
- win/loss state
- finished session status

## Combat Roadmap

Build combat in small layers. Do not start with full Magic combat rules, because power/toughness, blockers, combat damage, trample, first strike, summoning sickness, vigilance, and special card text all add complexity quickly.

Recommended order:

1. Store combat declarations.
2. Add `declare_attacker`.
3. Show current attackers in the UI.
4. Add `declare_blocker`.
5. Add simple card stats for creatures.
6. Resolve basic combat damage.
7. Add special rules and card effects later.

First combat table:

```text
game_combat_assignments
- id
- session_id
- turn_number
- attacker_card_id
- attacking_player_id
- defending_player_id
- blocker_card_id nullable
- created_at
```

First combat RPCs:

- `declare_attacker(session_id, attacker_card_id, defending_player_id)`
- `declare_blocker(session_id, blocker_card_id, attacker_card_id)`
- `clear_combat_assignments(session_id)`

Implemented first slice:

- `game_combat_assignments`
- `declare_attacker`
- `declare_blocker`
- `clear_combat_assignments`
- `get_combat_assignments`
- `get_combat_action_state`
- attacker declaration taps the attacker
- combat assignments are cleared when leaving End of Combat Step and when a new turn reaches Untap Step
- board/controller show current combat assignments
- controller Attack and Block buttons are enabled from server-provided combat action state JSON
- `game_turn_state.priority_player_id` tracks who may act/advance right now, while `active_player_id` remains the turn owner

Initial `declare_attacker` rules:

- current user must be a player in the session
- current user must be the active player
- current step must be `declare_attackers`
- attacker card must be owned by the active player
- attacker card must be on the battlefield
- attacker card must be untapped
- defending player must be another player in the same session
- declaring an attacker taps the attacker for now

Initial `declare_blocker` rules:

- current user must be the defending player
- current user must be the priority player for the current block declaration window
- current step must be `declare_blockers`
- blocker card must be owned by the defending player
- blocker card must be on the battlefield
- blocker card must be untapped
- blocker can block one attacker for the first implementation
- declaring a blocker does not tap the blocker

Combat assignment cleanup:

- clear assignments when leaving `end_of_combat`
- also clear assignments when a new turn begins as a safety fallback

Creature stats should come after declarations. Start with simple nullable columns on `cards`:

```text
cards.power integer nullable
cards.toughness integer nullable
```

This only covers simple creatures. Real Magic values like `*`, `1+*`, or variable toughness should be modeled later with card scripts/effects.

First `resolve_combat_damage` behavior:

- unblocked attackers deal `power` damage to `defending_player_id`
- blocked attackers do not damage the player unless trample is implemented later
- damage to creatures can be skipped in the first version
- life changes should use the existing `adjust_player_life` path

## Priority And Stack Roadmap

`priority_player_id` is the first building block for Magic priority. It should stay separate from `active_player_id`.

Current meaning:

```text
active_player_id = the turn owner
priority_player_id = the player allowed to act or advance right now
```

Current usage:

- During normal turn steps, priority usually points to the active player.
- During Declare Blockers Step, priority can point to the defending player.
- The `Next Step` button uses `priority_player_id`.
- Combat action buttons use server-provided JSON from `get_combat_action_state`.

Important future rule:

Do not model priority as multiple players acting at the same time. Magic priority is sequential. Only one player has priority at a time, then priority is passed to the next player.

Future stack/priority model:

```text
game_priority_state
- session_id
- priority_player_id
- priority_cycle_started_by
- consecutive_passes
- stack_is_waiting
- updated_at
```

Possible first RPCs:

- `pass_priority(session_id)`
- `put_action_on_stack(session_id, source_card_id, action_payload)`
- `resolve_top_of_stack(session_id)`

Future `pass_priority` behavior:

1. Current `priority_player_id` passes.
2. Priority moves to the next player by `seat_number`.
3. If every relevant player passes in sequence:
   - resolve the top stack item if the stack is not empty
   - otherwise allow the step/phase to advance
4. If a player adds something to the stack, reset pass count and priority cycle.

For now, keep `priority_player_id` in `game_turn_state`. Only split it into a dedicated `game_priority_state` table once instants, activated abilities, and stack resolution become real features.

## Multi-Session Notes

Multiple games can run in parallel as long as each game uses a unique `session_id`.

Current session isolation:

- `game_cards.session_id` separates card state per game.
- `game_players` uses `(session_id, player_id)` so the same player can have separate mana pools in multiple games.
- `game_turn_state.session_id` is the primary key, so each session has one turn-state row.
- `game_turn_state.active_player_id` is the turn owner; `priority_player_id` is the player allowed to act/advance now.
- Board/controller queries and realtime subscriptions filter by `session_id`.

Known hardening work for later:

- Add a dedicated `game_sessions` table.
- Add a `game_session_players` table to explicitly track which players belong to each session.
- Update RPCs to reject actions from users who are not part of the session.
- Decide how active player changes at end of turn.
- Add cleanup/archival for old sessions, cards, player state, and turn state.

Current prototype caveat: `initialize_turn_state` allows any signed-in user to initialize a new session with themselves as active player. This is acceptable while prototyping, but should be tied to explicit session membership before multiplayer hardening.

## Notes

Next build currently warns that there is another `package-lock.json` at `C:\Users\jordy\package-lock.json`. The build still succeeds. To silence that warning later, either remove the unrelated parent lockfile or configure `turbopack.root` in `next.config.ts`.

Simpele stappen plan:

[x] Mana pool zichtbaar maken.
[x] Zones expliciet modelleren en tonen.
[x] Acties centraliseren in een typed executor: add_mana, tap, draw_card, move_zone.
[x] Kritieke acties verplaatsen naar Supabase RPC of Edge Function.
[x] Mana pool kunnen clearen.
[x] Turn state zichtbaar maken.
[x] Turn step handmatig kunnen doorschuiven.
[x] Untap Step automatiseert battlefield untap.
[x] Draw Step automatiseert een kaart trekken.
[x] Multiplayer sessies kunnen aanmaken/joinen/locken.
[x] Decks vanuit de sessielobby kunnen spawnen.
[x] Eerste RPC membership hardening op `advance_step`.
[x] Game sessies kunnen stoppen/finishen.
[x] Home toont bestaande sessies van de speler.
[x] Session read policies voor sessie-overzicht.
[x] Session player list via security-definer RPC.
[x] Seats tonen `profiles.username` met id fallback.
[x] Turn rotation naar de volgende session seat.
[x] Turn state realtime/fallback refresh voor actieve speler wissels.
[x] Life totals zichtbaar en aanpasbaar via RPC.
[x] Combat declarations opslaan.
[x] Attackers tonen in de UI.
[x] Blockers koppelen aan attackers.
[x] Blockers blijven untapped bij blocken.
[x] Priority player toevoegen voor blockers en later stack priority.
[ ] RLS policies strak maken per speler/session.
[ ] Priority passing roadmap uitwerken voor stack.
[ ] Creature power/toughness toevoegen.
[ ] Combat damage koppelen aan attackers/blockers.
[ ] Daarna pas complexere MTG-logica.
