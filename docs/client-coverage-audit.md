# Client coverage audit — engine vs UI

> **Refreshed 2026-06-14.** The original June audit (migs 239–285) inventoried a
> large engine→UI gap. Since then the client caught up: every item below the old
> audit flagged as missing is now implemented. This doc records that closure and
> points at what's *actually* next. Verify before acting on it — don't let it go
> stale again.

## Status — the old gaps are closed

### 1. Decision rendering — was THE critical gap, now FULL parity
The engine's decision vocabulary is the **28** types `submit_decision` consumes,
and `components/ControllerListV4.tsx` renders **all 28**:
- A `CARD_PICK_DECISIONS` set routes the 13 card-pick types
  (`reanimate_destroyed, look_top, copy_permanent, become_copy, bounce_pick,
  cast_exiled_free, put_from_hand_pick, destroy_pick, command_zone_pick,
  graveyard_exile_pick, fight_pick, etali_cast_pick, graveyard_to_top_pick`)
  to the shared `CardPickBody`.
- The five once-missing bodies exist: `ChooseWordBody` (choose_creature_type +
  vote), `ChooseColorBody`, `DivideDamageBody`, `PayXDamageBody`.

**Verified (static contract check, 2026-06-14):** every engine park site builds
options as `jsonb_build_object('game_card_id', id, 'name', c.name, …)`, and the
shared submit branch reads `{chosen:[ids]}` validated against
`options[].game_card_id` — an exact match to `CardPickBody`. `choose_up_to` /
`job_select` / `saga_chapters` look like types but aren't (script field /
effect-dispatch type / card-script field).

The `Unsupported decision: <type>` fallback is now effectively unreachable for
real cards.

### 2. Chosen cost payments — implemented
`p_cost_card_ids` (mig 284) is threaded end to end:
`components/controller/CardActionSheet.tsx` opens a `costPick` battlefield picker
for abilities with `sacrifice_artifacts` / `return_land` / `tap_creatures` costs
and passes `costCardIds` through `onActivateAbility` → `lib/game/actions.ts`. No
more silent auto-picking.

### 3. Game state — surfaced
| State | Where |
|---|---|
| Monarch | 👑 on opponent pills (`turnState.monarch_player_id`) |
| Attack tax | ⛔ on opponent pills, tooltip explains the mana/life cost |
| Animated lands | `animated` flag plumbed (mig 277), attackable lands shown |
| Poison counters | ☠ per player; **≥3 corrupted** highlight; lethal@10 in judge tools |
| Attachments | 📎N host badge + 🔗 attachment badge on the controller battlefield (`game_cards.attached_to`, added 2026-06-14) |
| Trigger targeting | `choose_trigger_target` client path (4 call sites) |

## What's actually next (fresh targets, not yet built)

1. **Big-screen board view is a stub.** `components/board/` is only chrome,
   connection overlay, and a stack rail; `app/board/[id]/page.tsx` renders no
   battlefield cards. This is now the largest unbuilt surface — the shared "couch"
   screen the whole table looks at. Everything above lives only on the personal
   controller. Building the board render (and re-applying the state badges there)
   is the high-leverage next step.
2. **Attachment naming across owners.** `getControllerCards` is owner-scoped, so
   an Aura you control on an *opponent's* creature shows 🔗 but can't name the
   host. A board-level (all-cards) lookup would resolve it.
3. **Onboarding.** `components/tutorial/` is still Supabase starter boilerplate —
   no in-game "your first turn" flow for couch-play guests.
4. Re-run a real engine-vs-UI scan after the next big engine arc; this doc is a
   snapshot, not a guarantee.
