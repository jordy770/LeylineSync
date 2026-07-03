# Open items — merged & verified

> **Single consolidated TODO**, built 2026-06-25 by reconciling every "deferred /
> remaining / known-gap / 🚧" note across `project_roadmap.md` (memory, froze ~mig
> 172), `cerebrum.md`, `docs/client-coverage-audit.md`, `docs/backlog.md`, and the
> buglog — then **verifying each against the actual codebase** (migrations up to
> 333, `functions_src`, `components`). Supersedes the scattered notes in those
> files for "what's left". Verify before acting — re-run a scan after the next big
> engine arc.

## TL;DR

The card-vocabulary engine is essentially complete (333 migrations). The roadmap
memory was ~17 days stale: **everything in cluster 1 below shipped after it froze.**
What genuinely remains is **1 real bug + ~13 deferred-by-choice gaps** (mostly
"engine done, niche client/authoring surface missing") + **3 architecture-frontier
items deferred by design**. No open bugs in the buglog (899 entries, all logged
fixed).

---

## ✅ Closed since the roadmap froze (don't re-plan)

Verified implemented at engine **and** client where applicable:

- **Cast-from-graveyard** — mig 173 (`cast_from_graveyard` effect), 206 (cast tracker), 215 (Havengul Lich), 321 (cast from exile). Unlocks Gisa & Geralf, Liliana −3, flashback.
- **Mass / token engines** — Army of the Damned (mig 174, tapped tokens + flashback), Grimoire of the Dead (214), Necromantic Selection (208), kicker/Josu Vess (211), Amass (182).
- **Curses / enchant-player** — mig 199 (Curse of Disturbance; `choose_player` enchant target + declare_attacker hook).
- **Sacrifice-cost activated abilities** — mig 183 (`sacrifice_creature` cost) + 175 (`sacrifice_self`); client `CardActionSheet`.
- **Copy / control-change cards** — mig 239 (copy_permanent, copy-token), 240 (become_copy + revert).
- **Mana-retention** — `mana_does_not_empty` effect (mig 106+) in `clear_mana_pool_for_step`; mig 329 manual reset.
- **Divided damage — trigger side** — mig 233 (`divide_damage` decision parks in `apply_trigger_effects`). Spell side was mig 115.
- **Commander late-joiner life** — mig 137: `create_game_session(p_format)` + `join_game_session` set life from session format (no more 20-life late joiners).
- **Command-zone strip** — `ControllerListV5` renders command-zone cards + Cast button + live tax `2 × command_zone_casts`.
- **Decision effects inside modal modes** — `apply_trigger_effects` / `submit_decision` resolve mode `actions` arrays.
- **choose_creature_type client UI** — `ControllerListV5` `ChooseWordBody` (regel 2484/2849) renders `options[{type}]` → submits `{type}`. (Distant Melody playable.)

---

## 🔴 Genuinely open

### Bug
1. ~~**Draw-floor bug**~~ — ✅ **FIXED (mig 334, 2026-06-25)**. The draw branch
   looped `1..greatest(1, v_eff_amount)`, so "draw a card for each X" with X=0 drew
   1. Now an absent `amount` key keeps the "draw a card" default of 1, while a
   present amount draws exactly that many (`1..(case when v_effect ? 'amount' then
   v_eff_amount else 1 end)` — `1..0` runs zero iterations). Tests DF1–DF3
   (`tests/feature/draw-floor.test.ts`) + fixtures Floor/Plain Drummer Test.

### Engine deferred-by-choice (niche, no demand noted)
2. **Castable "prevent damage to TARGET CREATURE" spell** — `add_creature_damage_prevention` exists (mig 147/148, targeted+combat) but no castable spell/trigger routes through it. OPEN.
3. **Opponent / chosen-player damage shields** — prevention only shields the controller ("prevent damage to YOU"). PARTIAL (mig 126 header flags it as a later slice).
4. **Redirect / replacement beyond prevention** — no generic "if damage would be dealt, instead…" / redirect. OPEN.
5. **Planeswalker static abilities** — only loyalty (triggered) abilities exist (mig 168). No `static_abilities`. OPEN.
6. **Burn / spell damage redirect to a planeswalker** — combat→loyalty works (mig 169); non-combat (burn) still hits the player. PARTIAL.
7. **`switch_pt` spell/trigger/script authoring** — layer 7e works (mig 146) but no `switch_pt` kind in `apply_creature_effect` / `trigger_effect_target_type` / builder. PARTIAL.
8. **"Toxic N" from the `cards.keywords` array** — only the `continuous_effects` form is parsed; `register_card_continuous_effects` keyword loop skips `toxic`. OPEN.
9. **Infect/wither + deathtouch destroying a creature** — counter path marks no damage, 704.5g needs `damage_marked>0`. OPEN (rare, documented).
10. **each_opponent / multiplayer-aware discard picker** — `each_opponent` does random batch; chosen-discard picks the first opponent by seat. No per-opponent choice queue. PARTIAL.

### Authoring / client surface (engine done)
11. **Modal spells guided-form editor** — schema + cast path done; JSON/AI authorable only, no `CardBehaviorForm` modes widget. PARTIAL.
12. **`set_commander_redirect` UI toggle** — RPC exists (mig 142); never surfaced in any component. PARTIAL.
13. **`cleanup_finished_session` client call** — RPC exists (mig 144); only called from tests/harness, no production trigger. OPEN (low — could be a cron/service job instead).
14. **hybrid/Phyrexian mana picker UI** — engine auto-pays {W/U},{2/W},{W/P} (mig 121); no player-choice picker client-side. PARTIAL (shared-UI follow-up).

---

## 🔵 Architecture frontier (deferred by design — not "TODO")

- **DFC / `effective_characteristics`** — transform/exert works (mig 236) but no true double-faced card with two independent sides. The `effective_script` seam reserves the spot.
- **Broader `apply_effect` unification** — one effect switch shared by spells/abilities/triggers (`apply_creature_effect` is the first slice).
- **Pure-TS `reduce(state, action)` rules core** — only justified at the replacement/layer frontier; rules remain in PL/pgSQL. Not a rewrite-now.

---

**How to apply:** Item 1 (draw-floor) is the only correctness bug — quick win. Items
2–14 are deliberate scope cuts; pull from them when a target deck needs one. The
frontier items are conscious deferrals, not backlog. The active development thread
has shifted to **bots, couch-play UX, and real-deck polish** (see git history) —
the effect engine is in maintenance/long-tail territory.
