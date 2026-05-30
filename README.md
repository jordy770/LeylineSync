# Leyline Sync

Realtime Magic: The Gathering style board/controller app built with Next.js and Supabase.

The app has four main screens:

- `/` session lobby for creating, joining, locking, finishing, and spawning decks.
- `/decks` deck manager for importing and editing reusable decklists.
- `/board/[id]` shared board view.
- `/controller/[id]` player controller view.

The important design choice is that browser UI does not directly mutate critical game state. Most gameplay changes go through Supabase RPC functions, so rules live close to the database rows they protect.

## Controller Views

The controller page supports several rendering versions, selected with a `?v=` query parameter on `/controller/[id]`:

- default (no param): `ControllerListV2`, the polished tabbed controller.
- `?v=1`: `ControllerList`, the original legacy controller.
- `?v=3`: `ControllerListV3`, the bare-HTML state-machine reference.
- `?v=4`: `ControllerListV4`, the production landscape-mobile controller.

`ControllerListV4` is the current target design. It is a single-screen landscape layout that adapts to the turn state instead of using tabs. Its layout state is derived from the turn step, priority, stack, and incoming attackers, and switches between a default board view and dedicated Declare Attackers / Declare Blockers full-screen layouts.

V4 features:

- **Status bar** with a sliding gold step indicator (grouped phases), active-player dot, floating mana pool pips, library count, life total, and a priority (`YOU`) marker.
- **Card-first interaction.** Tapping a battlefield card with a single simple `{T}: add mana` ability taps it directly; anything more complex opens a bottom `CardActionSheet`. There is no separate mana sidebar — cards are the interaction surface.
- **CardActionSheet** shows zone-aware abilities (a land in hand offers Play, not its battlefield mana ability), a Cast button with mana-cost pips, mana abilities, and a tappable thumbnail that opens a full `CardZoomOverlay` with oracle text.
- **Playability glow.** During a priority window, castable cards get an amber ring and uncastable ones dim. Affordability is checked against untapped lands plus floating mana, and lands respect the one-per-turn limit.
- **Combat layouts.** Declare Attackers filters out summoning-sick creatures (no haste) and tapped creatures. Confirming declarations passes priority rather than force-advancing the step, so opponents get their instant-speed window. A combat-damage strip shows attacker → blocker matchups.
- **Opponent inspection.** Compact opponent pills show life, hand count, permanents, and graveyard count at a glance; tapping one opens an `OpponentBoardOverlay` with tabbed Board / Graveyard / Exile zones. Face-down exiled cards render hidden.
- **Own zones.** `GY` and `EX` buttons on the hand strip open a `MyZonesSheet` for your graveyard and exile.
- **Cleanup discard.** When it is your cleanup step and your hand is over seven cards, a discard banner appears and tapping hand cards discards them to the graveyard.
- **Priority is pass-only.** There is no "next step" shortcut in V4; the step advances on the server only when all players pass priority, so every player always receives priority.

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
NEXT_PUBLIC_ENABLE_FALLBACK_REFRESH=true
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

## Card Catalog Import

The repo includes a Scryfall bulk JSON file at:

```text
lib/default-cards-20260429211148.json
```

Import a clean English card catalog into `public.cards` with:

```powershell
npm run import:cards
```

By default this imports:

- English cards only
- non-digital cards only
- one representative print per `oracle_id`
- playable cards only, skipping tokens, art cards, emblems, planes, schemes, minigames, stickers, and similar extras

Test without writing to Supabase:

```powershell
npm run import:cards -- --dry-run --limit 5
```

Useful options:

```powershell
npm run import:cards -- --limit 1000
npm run import:cards -- --batch-size 250
npm run import:cards -- --include-digital
npm run import:cards -- --include-non-english
npm run import:cards -- --all-prints
npm run import:cards -- --include-extras
npm run import:cards -- --file path/to/scryfall.json
```

If Supabase returns `TypeError: fetch failed` during a large import, rerun with a smaller batch:

```powershell
npm run import:cards -- --batch-size 25
```

The importer retries failed batches automatically, but large rows plus network/PostgREST limits can still make smaller batches more reliable.

The importer reads the file as a stream, so it can handle large Scryfall JSON arrays. It upserts card metadata by `cards.id = scryfall.id` and updates:

- `name`
- `mana_cost`
- `type_line`
- `oracle_text`
- `power_toughness`
- `keywords`
- `image_url`
- `power`
- `toughness`

It does not update `script`. New imported rows rely on the table default for `script`, and existing playable scripts stay intact. Add gameplay scripts later through focused migrations or override tooling.

Import translated/non-English cards only if you want language prints as separate catalog rows:

```powershell
npm run import:cards -- --include-non-english
```

Import every print instead of one representative print per `oracle_id` only if you want print-level collecting/search:

```powershell
npm run import:cards -- --all-prints
```

For a real import, use a service role key locally:

```env
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

Never expose the service role key in browser code or commit it.

Recommended checks after a full import:

- Search a few known cards in the dev admin card picker.
- Check that `image_url`, `mana_cost`, `type_line`, `keywords`, and power/toughness look right.
- Spawn a few simple creatures and confirm their controller card preview renders.
- Spawn cards with supported keywords such as `Flying`, `Reach`, `Trample`, `Vigilance`, `First strike`, and `Double strike`.
- Use `Rebuild Effects` or replay the card to refresh keyword-backed continuous effects on existing battlefield cards.

The importer should stay focused on reference metadata. Do not generate gameplay `script` from Oracle text automatically; add supported gameplay behavior through migrations or a future override system.

## Project Layout

```text
app/
  decks/page.tsx             Deck import/manage page
  board/[id]/page.tsx         Shared board page
  controller/[id]/page.tsx    Player controller page

components/
  GameSessionLobby.tsx        Session list/create/join/spawn controls
  DeckManager.tsx             Text decklist import, user deck list, and simple deck editor
  GameBoard.tsx               Battlefield board rendering
  ControllerList.tsx          Player hand/battlefield controls
  ActionButtons.tsx           Executes card script actions
  CardZoneControls.tsx        Plays/casts cards from hand and moves zones
  CardCatalogPicker.tsx       Reusable card catalog search/filter picker
  ManaPool.tsx                Current player's mana pool
  TurnStatusPanel.tsx         Current turn/phase/priority UI
  StackPanel.tsx              Pending stack items
  CombatAssignmentsPanel.tsx  Current combat assignments
  LifeTotalsPanel.tsx         Life totals and manual adjustment

lib/game/
  actions.ts                  Client wrappers around RPCs and Edge Functions
  data.ts                     Client read/query helpers and normalizers
  types.ts                    Shared TypeScript domain types
  card-behavior-schema.ts     Zod schemas for V1 and V2 card scripts, validateCardScript()

scripts/
  validate-card-scripts.ts    Audit script — validates all card scripts in the DB

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
- `name`
- `list_data`: array of `cards.id` values
- `created_by`
- `created_at`

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
- `controller_player_id`
- `zone`: `library`, `hand`, `stack`, `battlefield`, `graveyard`, `exile`
- `zone_position`
- `is_tapped`
- `damage_marked`
- `position_x`
- `position_y`
- `copied_script`
- `static_effects_suppressed`
- `entered_battlefield_turn_number`: turn the card entered the battlefield, used for summoning sickness
- `is_face_down`: card is exiled face-down and hidden from other players
- `plus_one_counters`: number of +1/+1 counters; each raises effective power and toughness by 1

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
- `first_strike_damage_resolved`

`game_combat_blockers`

- `assignment_id`
- `session_id`
- `turn_number`
- `attacker_card_id`
- `blocker_card_id`
- `blocking_player_id`
- `damage_assignment_order`

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
- `source_zone_required`
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

## Dev Controls

Debug/test UI is hidden by default. Enable it locally with:

```env
NEXT_PUBLIC_SHOW_DEV_CONTROLS=true
```

Currently gated dev controls:

- Dev Admin panel for adding mana, spawning cards, and setting phase/step.
- Dev Admin card picker with search, type/color/keyword filters, and selected-card preview.
- Static-effect lifecycle panel on battlefield cards.
- Manual card tap/untap button.
- Manual battlefield zone moves such as `To Hand` and `Graveyard`.
- Player action panel with manual draw, untap all, and clear mana.
- Judge card tools, including `Clear Summoning Sickness` on battlefield cards (zeroes `entered_battlefield_turn_number` via `dev_clear_summoning_sickness`).

Normal gameplay controls remain visible without this flag, including play/cast, card script actions, combat controls, priority passing, stack display, turn status, mana pool, and life totals.

## Refresh Behavior

The app uses Supabase Realtime subscriptions and also has a 2-second fallback refresh for important panels. Disable the fallback polling locally with:

```env
NEXT_PUBLIC_ENABLE_FALLBACK_REFRESH=false
```

When disabled, the UI still loads initial data and reacts to realtime events, but it will no longer poll every 2 seconds.

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
- `get_land_play_limit(session_id, player_id)`
- `register_card_continuous_effects(session_id, source_card_id)`
- `rebuild_scripted_continuous_effects(session_id)`
- `set_card_controller(game_card_id, controller_player_id)`
- `set_card_copied_script(game_card_id, copied_script)`
- `set_card_static_effects_suppressed(game_card_id, suppressed)`
- `expire_continuous_effects_for_step(session_id, turn_number, phase, step)`
- `create_mana_retention_effect(session_id, source_card_id, colors, affected_player_id, expires_at_phase, expires_at_step, should_tap_card)`

Turn, priority, stack:

- `initialize_turn_state(session_id, active_player_id)`
- `get_turn_state(session_id)`
- `advance_step(session_id)`
- `pass_priority(session_id)`
- `put_action_on_stack(session_id, action_type, payload, source_card_id)`
- `resolve_top_of_stack(session_id)`
- `get_stack_items(session_id)`

Combat and results:

- `declare_attacker(session_id, attacker_card_id, defending_player_id)`
- `declare_blocker(session_id, blocker_card_id, attacker_card_id)`
- `set_combat_blocker_order(session_id, assignment_id, blocker_card_ids)`
- `clear_combat_assignments(session_id)`
- `get_combat_assignments(session_id)`
- `get_combat_action_state(session_id)`
- `resolve_combat_damage(session_id)`
- `adjust_player_life(session_id, target_player_id, delta)`
- `maybe_finish_game_session(session_id)`

## Card Script Validation

`cards.script` is validated at runtime using Zod schemas defined in `lib/game/card-behavior-schema.ts`.

The validator understands both the V1 legacy format (`{ actions, triggers, continuous_effects }`) and the V2 structured format (`{ schema_version: 2, spell_effect, activated_abilities, ... }`). Version detection mirrors `getCardBehaviorVersion` in `card-behavior.ts`.

In development (`NODE_ENV === 'development'`), `normalizeCardBehaviorToV2` automatically warns in the browser console whenever a card with an invalid script is loaded:

```text
[card-behavior] Invalid card script (v1):
  • actions.0.color: Invalid enum value. Expected 'W' | 'U' | 'B' | 'R' | 'G' | 'C'
```

To audit all card scripts in the database:

```powershell
npm run validate:scripts
```

This requires `NEXT_PUBLIC_SUPABASE_URL` and either `SUPABASE_SERVICE_ROLE_KEY` (preferred) or `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in the environment. It exits with code 1 and prints every failing card and field if any scripts are invalid.

The validator enforces:

- `.strict()` at the top level of both V1 and V2 — no hallucinated top-level keys.
- Known action types (`add_mana`, `deal_damage`, `counter_spell` in V1; `add_mana`, `deal_damage`, `counter` in V2) are validated with their required fields.
- `color` on `add_mana` must be one of `W`, `U`, `B`, `R`, `G`, `C`.
- Unknown action types pass through, so adding new mechanics does not require updating the schema first.

Never auto-generate `cards.script` content from oracle text. Always add scripts through deliberate migrations or a future override system.

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

Counter target spell:

```json
{
  "actions": [
    {
      "type": "counter_spell",
      "target": "spell",
      "timing": "instant"
    }
  ],
  "triggers": ["cast"]
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

Current supported script continuous effects:

```json
{
  "continuous_effects": [
    {
      "type": "additional_land_plays",
      "amount": 1,
      "affected": "controller",
      "source_zone_required": "battlefield"
    }
  ]
}
```

Continuous effects are registered into `game_continuous_effects` when the source permanent enters the battlefield through `register_card_continuous_effects`. The current supported `affected` values are `controller`, `self`, `all`, and `all_players`. Use `source_zone_required: "battlefield"` for effects that should only count while the source card remains on the battlefield.

Imported Scryfall `cards.keywords` are also used for supported built-in keyword effects. The current keyword-to-effect mapping is:

- `Flying` -> `flying`
- `Reach` -> `reach`
- `Haste` -> `haste`
- `Vigilance` -> `vigilance`
- `Trample` -> `trample`
- `Indestructible` -> `indestructible`
- `First strike` -> `first_strike`
- `Double strike` -> `double_strike`
- `Deathtouch` -> `deathtouch`

Other imported keywords are kept as card metadata, but they do not affect rules until the engine supports them.

Scripted continuous effects are treated as derived runtime state. The source of truth is the current `game_cards` row:

- `controller_player_id` decides who receives `affected: "controller"` effects.
- `copied_script` can override the printed card script for copy effects.
- `static_effects_suppressed` disables script-registered static effects from that source.
- `rebuild_scripted_continuous_effects(session_id)` deletes old script-registered rows and rebuilds them from current battlefield permanents.

This rebuild approach handles normal battlefield enter/leave, gives copy/control-change mechanics a clear integration point, and avoids stale static effect rows becoming the authority.

Test cards added by migration:

- `Exploration Test`: Enchantment, `{G}`, gives its controller one additional land play while on the battlefield.
- `Green Mana Vessel Test`: Artifact, `{2}`, keeps green mana from emptying while on the battlefield.

Real continuous-effect cards added by migration:

- `Exploration`: Enchantment, `{G}`, gives its controller one additional land play while on the battlefield.
- `Azusa, Lost but Seeking`: Legendary Creature, `{2}{G}`, gives its controller two additional land plays while on the battlefield.
- `Upwelling`: Enchantment, `{3}{G}`, all players keep all mana as steps and phases end while on the battlefield.
- `Omnath, Locus of Mana`: Legendary Creature, `{2}{G}`, its controller keeps green mana as steps and phases end while on the battlefield.
- `Raging Goblin`: Creature, `{R}`, has haste and can attack the turn it enters.
- `Serra Angel`: Creature, `{3}{W}{W}`, has vigilance and does not tap when attacking.
- `Darksteel Myr`: Artifact Creature, `{3}`, has indestructible and survives lethal damage.
- `Colossal Dreadmaw`: Creature, `{4}{G}{G}`, has trample and can push excess combat damage through blockers.
- `White Knight`: Creature, `{W}{W}`, has first strike.
- `Fencing Ace`: Creature, `{1}{W}`, has double strike.
- `Serra Angel`: Creature, `{3}{W}{W}`, has flying and vigilance (script updated to include both explicitly).

Test cards added by migration for flying/reach:

- `Air Elemental Test`: Creature, `{2}{U}{U}`, 4/4, has flying.
- `Silhana Ledgewalker Test`: Creature, `{1}{G}`, 1/1, has reach.

Test cards added by migration for deathtouch:

- `Deathtouch Viper Test`: Creature, `{B}`, 1/1, has deathtouch.
- `Deathtouch Trampler Test`: Creature, `{3}{B}{G}`, 5/5, has deathtouch and trample (assigns 1 to each blocker, tramples the rest to the player).

The controller view includes a compact `Static effects` panel on battlefield cards for early lifecycle testing:

- `Rebuild Effects` recalculates script-registered continuous effects for the session.
- `Suppress Effects` / `Unsuppress Effects` toggles `static_effects_suppressed`.
- `Set Controller` updates `controller_player_id` and rebuilds effects.
- Copy presets can set or clear `copied_script` for simple copy-effect testing.

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
- Generic costs can be paid with a player-chosen mix of `W`, `U`, `B`, `R`, `G`, and `C`.
- If no generic payment choice is passed, the RPC still falls back to the old automatic order: `C`, `W`, `U`, `B`, `R`, `G`.
- Hybrid, Phyrexian, X, reducers, taxes, alternate costs, and cost increases are not modeled yet.

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
- A player can play one land per turn by default.
- `additional_land_plays` continuous effects can raise that limit.
- Lands require active player, main phase, priority, and empty stack.
- Turn status and hand card controls show `lands_played_this_turn` against the current land play limit, such as `0/1`, `1/2`, or `2/3`.
- Basic lands can use `add_mana` scripts on battlefield.

Current nonland permanent behavior:

- Non-Instant/Sorcery cards can be cast from hand through `cast_card_from_hand`.
- The RPC pays `cards.mana_cost`.
- The card moves to the `stack` zone and creates a `cast_permanent` stack item.
- When all players pass priority, `resolve_top_of_stack` moves the card to battlefield.
- Permanents track `entered_battlefield_turn_number` for summoning sickness.

Current attacking behavior:

- Only creatures can attack.
- Creatures that entered the battlefield during the current turn cannot attack.
- `haste` continuous effects bypass summoning sickness.
- `vigilance` continuous effects let a creature attack without tapping.
- `trample` continuous effects let excess blocker damage hit the defending player.
- `indestructible` continuous effects prevent lethal damage from moving the creature to graveyard.
- `first_strike` continuous effects let a creature deal damage in the first-strike combat damage pass.
- `double_strike` continuous effects let a creature deal damage in both first-strike and regular combat damage passes.
- `deathtouch` continuous effects make any amount of damage (>= 1) from the source lethal. A deathtouch attacker assigns only 1 to each blocker; combined with `trample`, the rest tramples to the defending player automatically.

Current Instant/Sorcery behavior:

- The card is cast through its `ActionButtons` spell action.
- Mana cost is paid if the source card is in hand.
- A `game_stack_items` row is created.
- The source card moves from hand to graveyard.
- When all players pass priority, the top stack item resolves.
- `Counterspell` can target a pending stack item.
- When a `counter_spell` stack item resolves, the target stack item is marked `cancelled`.
- If the countered target is a permanent spell, its source card moves from `stack` to graveyard.

Supported targeted stack actions:

- `deal_damage_player` — burn to a player (payload `{ target_player_id, amount }`).
- `deal_damage_creature` — burn/removal to a creature (`{ target_card_id, amount }`); on resolution it marks damage and re-checks lethal.
- `pump_creature` — combat trick (`{ target_card_id, power, toughness }`); on resolution it creates an until-end-of-turn pump on the target.
- `counter_spell` — targets a pending stack item.

A spell's script `actions` decide which targets the V4 controller offers: `deal_damage` with `target_type` including `player`/`creature`/`any` shows the matching choices, and a `pump` action shows creature targets. If the target has left the battlefield by resolution the spell fizzles harmlessly. Seeded test spells: `Lightning Strike Test` (`{1}{R}`, 3 damage any target) and `Giant Growth Test` (`{G}`, +3/+3 to target creature).

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
- Multiple blockers per attacker are supported.
- The attacking player can reorder multiple blockers to choose combat damage order.
- Combat damage is resolved manually during Combat Damage Step.
- Unblocked attackers damage defending player.
- Blocked attackers mark damage on blockers.
- Blockers mark damage back on attackers.
- If first strike or double strike is present, the first `Resolve Combat Damage` click resolves first-strike damage only.
- The next `Resolve Combat Damage` click resolves regular damage.
- Blocked trample attackers assign lethal damage to blockers, then excess damage to the defending player.
- Multiple-blocker damage assignment follows the chosen blocker order.
- Creatures with lethal marked damage move to graveyard.
- Indestructible creatures stay on the battlefield even with lethal marked damage.
- Marked damage clears during Cleanup Step.

Current limitations:

- No protection/prevention/replacement effects.
- Multiple-blocker damage amounts are still automatic; there is no player-chosen over-assignment yet.
- No planeswalker/battle targets.
- Flying legality is enforced by `declare_blocker`. If the attacker has a `flying` continuous effect, only blockers with `flying` or `reach` are accepted. Make sure to call `Rebuild Effects` (or `register_card_continuous_effects`) after a flying or reach card enters the battlefield so the effect is registered before combat.

## Power/Toughness Modifiers

A creature's effective power/toughness is its printed value plus modifiers:

- **+1/+1 counters** — permanent, stored in `game_cards.plus_one_counters`. Adjust with `adjust_card_counters(session, card, delta)`.
- **Until-end-of-turn pumps** — `game_continuous_effects` rows of `effect_type = 'pump'` with `{ power, toughness }` payload, created by `create_pt_pump(session, target, power, toughness)`. They expire during the cleanup step via `expire_continuous_effects_for_step`.

`card_effective_power(session, card)` and `card_effective_toughness(session, card)` fold both in. `resolve_combat_damage` and `move_lethal_damaged_creatures_to_graveyard` use the effective values, and `get_combat_assignments` exposes `attacker_power`/`attacker_toughness` so the controller can show real combat numbers (including counters and pumps) during declare blockers. Counters reset to 0 when a creature dies. Negative pumps are allowed but a creature reduced to 0 toughness without marked damage is not yet swept as a state-based action.

## Tokens

Tokens are catalog `cards` rows flagged `is_token = true` (seeded set: Soldier, Saproling, Zombie, Goblin, Beast, and a flying Spirit). A token instance is a normal `game_cards` row, so combat, P/T, counters, pumps, and display all work unchanged.

- `create_token(session, player, token_card_id, count)` spawns 1–20 tokens onto a player's battlefield and registers their continuous effects (e.g. the Spirit's flying).
- A token that leaves the battlefield ceases to exist: an `after update of zone` trigger (`cease_token_if_off_battlefield`) deletes the instance and its continuous effects when its zone changes away from `battlefield` — so dying, getting bounced, or being exiled removes the token instead of piling it up in another zone.
- Judge tools expose a "Create Token" control; the V4 controller shows a `Token` badge on the card sheet.

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
- `game_combat_blockers`
- `game_stack_items`
- `game_continuous_effects`

Add tables to Supabase Realtime when needed:

```sql
alter publication supabase_realtime add table public.game_cards;
alter publication supabase_realtime add table public.game_players;
alter publication supabase_realtime add table public.game_turn_state;
alter publication supabase_realtime add table public.game_session_players;
alter publication supabase_realtime add table public.game_combat_blockers;
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
- shuffles the deck before inserting, so library order is different for each game

The `/decks` page includes a text deck import tool and a simple deck editor. It accepts one card per line with optional counts:

```text
4 Lightning Bolt
4x Counterspell
24 Island
```

The import RPC stores matched card IDs in `decks.list_data`. Lines that do not match a card are reported as not accepted and skipped. The deck editor can add cards with quantities, update quantities, and remove cards. The lobby loads the current user's decks and lets the player select a deck by name instead of pasting a UUID.

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
202605010039_chosen_generic_mana_payment.sql
202605010040_turn_state_display_rpc.sql
202605010041_permanent_spells_use_stack.sql
202605010042_battlefield_static_effects_land_limit.sql
202605010043_scripted_continuous_effect_cards.sql
202605010044_static_effect_lifecycle_rebuild.sql
202605010045_real_continuous_effect_cards.sql
202605010046_summoning_sickness_and_haste.sql
202605010047_dev_admin_tools.sql
202605010048_vigilance.sql
202605010049_combat_keywords_and_multiple_blockers.sql
202605010050_first_strike_double_strike.sql
202605010051_sync_gemini_card_seed.sql
202605010052_blocker_damage_order.sql
202605010053_counterspell_stack_action.sql
202605010054_stack_action_type_counterspell_constraint.sql
202605010055_register_keyword_continuous_effects.sql
202605010056_restore_scripted_card_behaviors.sql
202605010057_deck_import_from_text.sql
202605010058_deck_read_policy_own_decks.sql
202605010059_update_deck_list.sql
202605010060_fix_deck_import_quantity_parser.sql
202605010061_deck_owner_id_compat.sql
202605010062_judge_draw_tools.sql
202605010063_card_behavior_compat.sql
202605010064_flying_and_reach.sql
202605010065_dev_clear_summoning_sickness.sql
202605010066_exile_face_down.sql
202605010067_deathtouch.sql
202605010068_plus_one_counters.sql
202605010069_until_end_of_turn_pumps.sql
202605010070_tokens.sql
202605010071_creature_targeting_spells.sql
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
- source_zone_required nullable
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

Example: additional land plays while source is on battlefield

```json
{
  "effect_type": "additional_land_plays",
  "source_card_id": "game_card_id",
  "source_zone_required": "battlefield",
  "affected_player_id": "controller_player_id",
  "payload": {
    "amount": 1
  }
}
```

`get_land_play_limit` starts at `1` and adds active `additional_land_plays` effects. If `source_zone_required` is set, the effect only counts while the source card is still in that zone.

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
- This is now implemented for script-registered `indestructible` effects.

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
- The current implementation supports multiple blockers and uses the attacking player's chosen blocker order.

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

Example: flying and reach

```json
{ "effect_type": "flying", "affected_card_id": "game_card_id", "payload": {} }
```

```json
{ "effect_type": "reach", "affected_card_id": "game_card_id", "payload": {} }
```

Where to apply it:

- In `declare_blocker`.
- If the attacker has a `flying` continuous effect, only blockers with `flying` or `reach` are accepted.
- `reach` alone does not grant flying — a reach creature is still blocked normally by non-flying creatures.
- After the full Scryfall import, `Flying` and `Reach` in `cards.keywords` are automatically registered via `register_card_continuous_effects`.

Example: first strike and double strike

```json
{
  "effect_type": "first_strike",
  "affected_card_id": "game_card_id",
  "payload": {}
}
```

```json
{
  "effect_type": "double_strike",
  "affected_card_id": "game_card_id",
  "payload": {}
}
```

Where to apply it:

- In `resolve_combat_damage`.
- If any first strike or double strike creature is involved, resolve a first-strike pass first.
- Move lethal non-indestructible creatures to graveyard before the regular damage pass.
- Double strike creatures also deal damage during the regular pass.

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
- [x] Player-chosen payment for generic mana costs
- [x] Permanent spells through stack instead of direct battlefield movement
- [x] Land play UI state that shows remaining land plays
- [x] Battlefield-gated continuous effects for land play limits
- [x] Basic registration of continuous effects from card scripts
- [x] Static-effect lifecycle rebuild for zone moves, copies, controller changes, and suppression flags
- [x] Real continuous-effect card data for Exploration, Azusa, Upwelling, and Omnath
- [x] Controller UI controls for static-effect lifecycle testing
- [x] Summoning sickness and basic haste support
- [x] Dev admin panel for adding mana, spawning cards, and setting turn state
- [x] Vigilance
- [x] Trample
- [x] Indestructible
- [x] Multiple blockers and automatic damage assignment
- [x] First strike / double strike
- [x] Deathtouch (lethal at 1 damage, interacts with trample)
- [x] Player-chosen blocker order
- [x] Basic counterspell stack cancellation
- [x] Supported keyword effects from imported Scryfall `keywords`
- [x] Better card picker/search filters for large imported catalogs
- [x] Text decklist import into `decks`
- [x] Randomized deck order when spawning a game library
- [x] Simple deck editor for adding, removing, and updating card quantities

High-value next work:

- [x] Zod schema validation for `cards.script` (V1 + V2), dev-mode console warnings, and `npm run validate:scripts` audit tool
- [x] Flying and Reach combat legality
- [x] Cleanup hand-size discard (V4 controller)
- [x] Landscape-mobile production controller (V4) with card-first interaction, zone inspection, and pass-only priority
- [x] +1/+1 counters (effective power/toughness in combat, display, judge stepper)
- [x] Until-end-of-turn power/toughness pumps (effect with cleanup expiry, effective P/T in combat, judge control)
- [x] Token creation (is_token catalog rows, create_token RPC, cease-to-exist trigger, judge control)
- [ ] Player-chosen combat damage over-assignment amounts
- [x] Creature-targeting spells from hand through the stack — burn/removal (`deal_damage_creature`) and combat tricks (`pump_creature`) cast and targeted from hand
- [ ] State-based action sweep for 0-toughness creatures (e.g. from negative pumps) without marked damage
- [ ] Card script override system separate from imported Scryfall metadata
- [ ] Real card-specific UI/actions for copy, control-change, and suppression effects
- [ ] Real card implementations for mana-retention effects, parked until later
- [ ] Scheduled cleanup for old finished game runtime data

## Known Caveats

- Counterspell cancellation exists, but there is no full target legality/replacement/protection model yet. In the V4 controller, casting a counterspell auto-targets the top (most recently cast) stack item; there is no per-item target picker yet.
- The V4 `CardActionSheet` lists non-mana activated abilities but they are not yet server-wired, so they show as `Soon`.
- Instant/Sorcery cards still move from hand to graveyard when put on the stack. Permanent spells use the `stack` zone.
- Mana cost parsing is intentionally simple.
- Priority is good enough for early stack work, but not a full rules-engine implementation.
- Public `cards` metadata is treated as shared reference data. If hidden decklists or private collections matter later, add separate RLS boundaries.
- Next build may warn about another `package-lock.json` at `C:\Users\jordy\package-lock.json`; the build can still succeed. Configure `turbopack.root` or remove the unrelated parent lockfile to silence it.
