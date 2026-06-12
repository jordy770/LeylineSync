# Client coverage audit — engine vs UI (June 2026)

The migs 239–285 arc grew the engine far past the client. This audit inventories
the gaps; numbers are from grepping `components/ + app/ + lib/` against the
canonical engine sources.

## 1. Decision rendering — THE critical gap

`components/ControllerListV4.tsx` (~line 1395) switches on `decision_type` and
knows **9** types; everything else renders the dead-end
`Unsupported decision: <type>`.

Engine total: **28** types (from `submit_decision`).

| Status | Types |
|---|---|
| ✅ Rendered | choose_mode, scry, surveil, search_library, choose_cards, sacrifice, return_from_graveyard, proliferate, confirm, choose_player |
| ❌ Unsupported (same submit shape as CardPickBody!) | reanimate_destroyed, look_top, copy_permanent, become_copy, bounce_pick, cast_exiled_free, put_from_hand_pick, destroy_pick, command_zone_pick, graveyard_exile_pick, fight_pick, etali_cast_pick, graveyard_to_top_pick |
| ❌ Unsupported (needs a new body) | choose_creature_type, choose_color, vote, divide_damage, pay_x_mana_damage |

**Cards currently unplayable through the UI** (their decisions dead-end):
Ureni, Sarkhan, Frostkite, Hammerhead Tyrant, Breaching Dragonstorm,
Broodcaller, Parapet Thrasher, Hellkite Courser, Mosswort Bridge, Selvala's
Stampede, Reality Shift, Deathgorge Scavenger, Savage Stomp, Wayta, Etali,
Noxious Revival, From the Rubble, Heraldic Banner, Leyline Tyrant, Naya Charm,
Dragonlord Atarka… (every card whose tests submit one of the ❌ types).

**The 80/20 fix:** the entire first ❌ row shares CardPickBody's exact contract
(`options = [{game_card_id, name}]`, submit `{chosen: [ids]}`, respect
min/max_choices). Routing those 13 types to the existing body is a one-line
condition change plus per-type prompt copy. That alone makes ~30 cards
playable. The five in the second row need small new bodies:
- `choose_creature_type` → option-list of `{type}` values, submit `{type}`
- `choose_color` → five-button picker, submit `{color}`
- `vote` → option-list of `{value}`, submit `{value}` (decision goes to the
  DECIDING player — vote chains alternate seats)
- `divide_damage` → allocate `params.amount` across up to
  `params.max_targets` options, submit `{allocations: [{game_card_id|player_id, amount}]}`
- `pay_x_mana_damage` → amount stepper + target pick

## 2. Chosen cost payments — dead engine feature

`p_cost_card_ids` (mig 284) appears **nowhere** in the client. Activations with
`sacrifice_artifacts` / `return_land` / `tap_creatures` costs silently
auto-pick (cheapest-MV / tapped-first). UI needed: when the ability's costs
include one of these, open a battlefield picker first and pass the ids.

## 3. Invisible game state

| State | Client refs | Impact |
|---|---|---|
| Poison counters (`game_session_players.counters.poison`) | 2 files | partially shown — verify the corrupted threshold (3+) is visible |
| Monarch (`game_turn_state.monarch_player_id`) | **0** | the crown is invisible: no indicator, end-step draw looks like a bug |
| Attack tax (`attack_tax` rows) | **0** | mana/life silently drains on attack with no explanation |
| Animated lands (`animated` rows) | **0** | a land that can attack looks like a plain land |
| Attachments (`attached_to`) | **0** in board render | equipment/aura relationships not drawn |
| Play-from-exile windows | **0** | impulse/Ixhel exiles look uncastable |
| Toxic / lifelink keyword badges | **0** | combat math surprises |

## 4. What's fine

- Trigger targeting (`choose_trigger_target`) has a client path (4 call sites
  in `lib/game/actions.ts`).
- Generic counters display exists (5 files) — bag counters likely visible.
- `is_commander` is referenced (1 file) — commander identity shown.

## Suggested order

1. Route the 13 CardPickBody-compatible types (hours, ~30 cards unlocked).
2. The five new decision bodies (vote and divide_damage matter most:
   Selvala's Stampede, Atarka, Naya Charm).
3. Cost-pick UI for `p_cost_card_ids`.
4. State badges: monarch chip, attack-tax warning on the attack button,
   animated-land glow, poison counter with corrupted highlight, attachment
   lines.
