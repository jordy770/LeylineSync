# Client coverage audit — engine vs UI

> ⚠️ **For the current merged "what's left" list see `docs/open-items.md`** (built
> 2026-06-25, verified vs migrations→333). This audit is a point-in-time snapshot.

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

## Big-screen board view (`components/GameBoard.tsx`)

The board IS built — `GameBoard.tsx` renders per-seat battlefields (focus +
grid + minimap variants), life totals, priority glow, stack rail, and combat
connections. (`components/board/` is just chrome; the page mounts `GameBoard`.)
Its gap was that **none of the controller's state badges existed here** — the
shared screen the whole table watches.

Board state parity — **DONE 2026-06-14**:
- **Seat badges** (`SeatStatusBadges`, all three panels): monarch 👑, poison ☠
  (≥3 corrupted / ≥10 lethal), attack-tax ⛔ (tooltip explains the per-attacker
  cost).
- **Card badges** (`BoardCardBadges`, focus + quadrant panels): attachments
  📎N (host) / 🔗 (attached, tooltip names host), animated lands ⚡.
- Plumbing: `getBoardCards` now selects `attached_to`; `useBoardGameState` folds
  `getStatusEffects` (animated ids + attack taxes) into board state and subscribes
  to `game_continuous_effects` for live updates. The minimap thumbnails are left
  un-badged (too small).

## RPC-coverage scan (2026-06-14)

Diffed all 102 authenticated RPCs vs the 78 the client calls. Nearly all of the
67 uncalled ones are internal engine helpers (`apply_*`/`fire_*`/`card_has_*`/
`resolve_*`, invoked via `perform`/`select` inside other RPCs). `order_pending_
triggers` (APNAP) is auto-invoked by `resolve_top_of_stack` — not a gap.

Genuine unsurfaced gaps found:
- **Commander damage — DONE 2026-06-14.** `game_commander_damage` (mig 137,
  21-from-one-commander lethal) was never loaded client-side — an invisible loss
  condition. Now: `getCommanderDamage` (resolves source game-card → name) loaded
  in both hooks (+ realtime), shown as a ⚔ badge (worst single-commander total;
  ≥15 amber / ≥21 red lethal; tooltip per source) on the controller status bar +
  opponent pills and on every board seat.
- **`set_commander_redirect`** (LOW/MED) — command-zone-vs-graveyard preference, unsurfaced.
- **`commander_deck_legality` — DONE 2026-06-17.** The deck editor (`DeckManager.tsx`) now shows server-authoritative Commander legality (`getDeckLegality` → the RPC) for decks with a commander designated: a green "✓ Commander-legal" or an amber issues list (100/singleton/colour-identity/commander). Also fixed an RPC bug (mig 316): the no-commander branch appended a bare string literal to a text[] → "malformed array literal"; cast to ::text.
- **`cleanup_finished_session`** (LOW) — post-game housekeeping, unsurfaced.

## Other fresh targets

1. **Attachment naming across owners — DONE 2026-06-17 (V5).** An Aura/Equipment
   you control on an *opponent's* creature now names its host: the controller's
   `cardNameById` lookup (ControllerListV5) is built from board-wide `boardCards`
   (spans every seat) instead of owner-scoped `battlefieldCards`. The 🔗 badge
   tooltip resolves cross-owner hosts.
1. **Attachment naming across owners — DONE 2026-06-22.** `getControllerCards`
   is owner-scoped, so an Aura you control on an *opponent's* creature showed 🔗
   but couldn't name the host. Fixed: `ControllerListV4`'s `cardNameById` is now
   built from `boardCards` (the whole-table snapshot) with `battlefieldCards`
   merged in as a fallback, so the 🔗 tooltip names cross-owner hosts.
2. **Onboarding — DONE 2026-06-14 (v1).** `ControllerCoachOverlay` — a short,
   skippable 5-slide first-run intro (controller vs board, playing cards, auto
   mana, auto-flowing priority, layout). Auto-opens once per device
   (`leyline-coach-seen-v1`), re-openable via the `?` in the status bar. NOT an
   interactive walkthrough — a quick orientation for couch-play guests. (The old
   `components/tutorial/` Supabase boilerplate is unrelated and still unused.)
3. Re-run a real engine-vs-UI scan after the next big engine arc; this doc is a
   snapshot, not a guarantee.
