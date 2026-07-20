# Cascade & Generalized Free Nested-Cast — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement MTG cascade by building a generalized "cast a card for free onto the stack, with target selection and ETB triggers," reusing the shipped triggered-ability targeting machinery.

**Architecture:** A new `cast_card_free` SQL routine dispatches a found card by type — permanents get a real `cast_permanent` stack push (true ETBs); instants/sorceries run through `cast_spell_effect` with a new `p_free` flag (no payment) after an optional target decision parked in the existing triggered-ability target shape. A `cascade` effect handler (adapted from `discover`) drives the exile-until-lesser-MV loop and the "may cast" decision; a shared `enqueue_cast_triggers` fires cascade from every cast path, so recursion is free.

**Tech Stack:** PostgreSQL (Supabase RPC functions in `supabase/functions_src/*.sql`), migrations via `scripts/new-migration.mjs`, TypeScript feature tests via `node:test` + the `tests/harness` Scenario API, run with `node scripts/run-tests.mjs`.

## Global Constraints

- Edit the CANONICAL function bodies in `supabase/functions_src/*.sql`, never past migrations. After editing, generate a migration: `node scripts/new-migration.mjs <name> <fn...>`, then rename the emitted file to the next `2026050104NN` sequence number (current head: `202605010417_sacrifice_or_filter.sql`).
- Migration-only helper functions (not seeded into `functions_src`) must be hand-copied from their LATEST migration when regenerating (bug-1280). None of this plan's functions are in that set, but `park_edict_sacrifice`, `build_stack_payload_*creature`, `creature_target_controller_ok`, `apply_damage_to_planeswalker` are — do not clobber them.
- Diff-check migrations code-only: strip `--` comment lines before comparing to the latest `create or replace` (em-dash/→ mojibake in comments creates false diffs).
- Card scripts use `schema_version: 2`. Spell effects live under `script.spell_effect.actions`; permanents' ETBs under `script.triggers`/`continuous_effects`.
- Test cards are added to `tests/fixtures/test-cards.json` (array of `{name, type_line, oracle_text, power_toughness, mana_cost, keywords, script}`). Reference them by exact name in tests.
- Fallback rule (RAW-honest): whenever a found card cannot be truly cast, it goes to the **bottom of the library in random order — never to hand**.
- Cascade threshold is strict `<` the cast spell's mana value. Since MV is a non-negative integer, implement as `<= castMV - 1`.
- After each task: `node scripts/run-tests.mjs` (full suite — hot-path changes), `rm -f tsconfig.tsbuildinfo && npx tsc --noEmit`, eslint. Commit per task.
- Do not commit to `master` without confirming with Jordy; branch first if he wants isolation. (This repo currently commits directly to `master` per its history — confirm his preference at execution start.)

## Reference anchors (read before implementing)

- `supabase/functions_src/cast_spell_effect.sql` — payment block at lines 154–214 (charges when source zone ∈ hand/exile); stack push at 216–233 (action_type `spell_effect`); post-cast zone move at 267–290. Signature line 6, grant line 295.
- `supabase/functions_src/cast_card_from_hand.sql:480–519` — the permanent stack push + `spell_cast` watcher fire; mirror for `cast_card_free`'s permanent path.
- `supabase/functions_src/apply_trigger_effects.sql:839–891` — the `discover` handler; adapt for `cascade`.
- `supabase/functions_src/submit_decision.sql:718–752` — the `cast_exiled_free` decision handler; adapt for `cascade_cast`. Decision-type allowlist at line 110.
- `supabase/functions_src/choose_triggered_ability_targets.sql:42–49` — the `action_type <> 'triggered_ability'` guard to relax.
- `supabase/functions_src/enqueue_triggered_ability.sql` — the target-metadata extraction (`trigger_effects_target_type`, `_target_controller`, `_target_count`) reused by the adaptor; the payload shape to mirror.
- `supabase/functions_src/resolve_top_of_stack.sql` — top-of-stack (highest `position`) resolves first; handler looked up in `stack_action_handlers`; non-null return parks, null finalizes.
- `tests/harness/scenario.ts` — Scenario API used in every test below.

---

### Task 1: Free-cast flag on `cast_spell_effect`

**Files:**
- Modify: `supabase/functions_src/cast_spell_effect.sql` (signature line 6; payment guard lines 158, 179; grant line 295)
- Test: `tests/feature/free-cast-flag.test.ts`
- Migration: `supabase/migrations/202605010418_free_cast_flag.sql` (generated)

**Interfaces:**
- Produces: `cast_spell_effect(p_session_id uuid, p_actions jsonb, p_source_card_id uuid default null, p_x_value integer default null, p_target_card_id uuid default null, p_adventure boolean default false, p_free boolean default false) returns game_stack_items` — when `p_free` is true, the payment block is skipped entirely (no mana charged, no flashback cost) while the source card is still moved and watchers still fire.

- [ ] **Step 1: Add the fixture spell** — append to `tests/fixtures/test-cards.json`:

```json
{
  "name": "Free Probe Bolt Test",
  "type_line": "Instant",
  "oracle_text": "Free Probe Bolt Test deals 3 damage to any target.",
  "power_toughness": null,
  "mana_cost": "{2}{R}",
  "script": { "schema_version": 2, "spell_effect": { "actions": [ { "type": "deal_damage", "amount": 3, "target_type": ["creature", "player"] } ] } }
}
```

- [ ] **Step 2: Write the failing test**

```ts
// Verifies p_free skips the payment block: a {2}{R} instant cast from exile with
// an empty mana pool succeeds only when free, and raises otherwise.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => { await ensureTestCards() })

async function castFromExile(s: Scenario, cardId: string, free: boolean) {
  return s.client.query(
    `select public.cast_spell_effect($1, $2::jsonb, $3, 0, null, false, $4)`,
    [s.sessionId, JSON.stringify([{ type: 'deal_damage', amount: 3, target_type: ['creature', 'player'] }]), cardId, free])
}

test('FC1 free cast from exile skips payment; non-free raises on empty pool', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const probeFree = await s.spawn('A', 'Free Probe Bolt Test', 'exile')
    const probePaid = await s.spawn('A', 'Free Probe Bolt Test', 'exile')
    await s.setMana('A', {}) // empty pool
    await s.as('A')

    // free = true → succeeds
    await castFromExile(s, probeFree, true)
    assert.equal(await s.zoneOf(probeFree), 'stack')

    // free = false → cannot pay {2}{R} with empty pool
    await assert.rejects(() => castFromExile(s, probePaid, false) as Promise<unknown>)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node scripts/run-tests.mjs free-cast-flag`
Expected: FAIL — `cast_spell_effect(...)` has no 7-arg overload (function signature mismatch).

- [ ] **Step 4: Add the `p_free` parameter and guard the payment block**

In `cast_spell_effect.sql`, add the parameter after `p_adventure`:

```sql
  p_adventure boolean default false,
  -- Free cast (mig 418, cascade / generalized nested-cast): skip the payment block
  -- entirely — no mana, no flashback cost — while still moving the source and firing
  -- watchers. The caller has already decided the cast is free.
  p_free boolean default false
```

Guard the hand/exile payment branch (line 158) and the graveyard/flashback branch (line 179):

```sql
  if not p_free and p_source_card_id is not null and v_source_zone in ('hand', 'exile') then
```
```sql
  elsif not p_free and p_source_card_id is not null and v_source_zone = 'graveyard' then
```

Update the grant at the bottom:

```sql
grant execute on function public.cast_spell_effect(uuid, jsonb, uuid, integer, uuid, boolean, boolean) to authenticated;
```

- [ ] **Step 5: Generate + sequence the migration**

Run: `node scripts/new-migration.mjs free_cast_flag cast_spell_effect`
Then rename the emitted file to `supabase/migrations/202605010418_free_cast_flag.sql`.

- [ ] **Step 6: Run test to verify it passes**

Run: `node scripts/run-tests.mjs free-cast-flag`
Expected: PASS (FC1).

- [ ] **Step 7: Full verification + commit**

```bash
node scripts/run-tests.mjs
rm -f tsconfig.tsbuildinfo && npx tsc --noEmit
git add supabase/functions_src/cast_spell_effect.sql supabase/migrations/202605010418_free_cast_flag.sql tests/fixtures/test-cards.json tests/feature/free-cast-flag.test.ts
git commit -m "feat(engine): p_free flag on cast_spell_effect — skip payment for free casts (mig 418)"
```

---

### Task 2: `cast_card_free` — permanent + no-target-spell paths

**Files:**
- Create (in a new canonical file): `supabase/functions_src/cast_card_free.sql`
- Test: `tests/feature/cast-card-free.test.ts`
- Migration: `supabase/migrations/202605010419_cast_card_free.sql` (generated)

**Interfaces:**
- Consumes: `cast_spell_effect(..., p_free := true)` from Task 1.
- Produces: `cast_card_free(p_session_id uuid, p_game_card_id uuid, p_controller uuid) returns uuid` — casts a card (currently in exile) for free. Permanents are pushed as a real `cast_permanent` stack item; instants/sorceries with no cast-time target are cast via `cast_spell_effect(p_free := true)`. Returns a parked `decision_id` when it defers to a target decision (Task 3), else null. In this task the targeted branch is a stub that returns the sentinel `-1`-style marker; Task 3 replaces it.

- [ ] **Step 1: Add fixtures** — append to `tests/fixtures/test-cards.json`:

```json
{
  "name": "Cascade Bear Test",
  "type_line": "Creature - Bear",
  "oracle_text": "",
  "power_toughness": "2/2",
  "mana_cost": "{1}{G}",
  "script": { "schema_version": 2 }
},
{
  "name": "Cascade Draw Test",
  "type_line": "Sorcery",
  "oracle_text": "Draw a card.",
  "power_toughness": null,
  "mana_cost": "{1}{U}",
  "script": { "schema_version": 2, "spell_effect": { "actions": [ { "type": "draw", "count": 1 } ] } }
}
```

- [ ] **Step 2: Write the failing test**

```ts
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => { await ensureTestCards() })

async function castFree(s: Scenario, cardId: string) {
  return s.client.query(`select public.cast_card_free($1, $2, $3) as decision_id`,
    [s.sessionId, cardId, s.playerId('A')])
}

test('CF1 free-casts a permanent from exile onto the battlefield', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bear = await s.spawn('A', 'Cascade Bear Test', 'exile')
    await s.as('A')
    await castFree(s, bear)
    // pushed as a cast_permanent stack item; resolve it to the battlefield
    await s.as('A').resolveStack()
    assert.equal(await s.zoneOf(bear), 'battlefield')
  })
})

test('CF2 free-casts a no-target sorcery from exile; it resolves and goes to graveyard', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    // give A a library card to draw
    await s.spawn('A', 'Grave Shambler Test', 'library')
    const draw = await s.spawn('A', 'Cascade Draw Test', 'exile')
    await s.as('A')
    await castFree(s, draw)
    await s.as('A').resolveStack() // resolves the spell_effect
    assert.equal(await s.zoneOf(draw), 'graveyard')
    assert.equal(await s.zoneCount('A', 'hand'), 1)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node scripts/run-tests.mjs cast-card-free`
Expected: FAIL — `function public.cast_card_free(...) does not exist`.

- [ ] **Step 4: Implement `cast_card_free` (permanent + no-target paths)**

Create `supabase/functions_src/cast_card_free.sql`. Mirror the permanent push from `cast_card_from_hand.sql:480–515` (move to stack, insert `cast_permanent` stack item at `max(position)+1`); for spells, extract `script->'spell_effect'->'actions'` and call `cast_spell_effect(..., p_free := true)`. Read the found card's type_line + script first.

```sql
-- supabase/functions_src/cast_card_free.sql
-- CANONICAL current definition.
create or replace function public.cast_card_free(
  p_session_id uuid, p_game_card_id uuid, p_controller uuid
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_type_line text;
  v_card_id uuid;
  v_script jsonb;
  v_actions jsonb;
  v_next_position integer;
  v_is_permanent boolean;
begin
  select gc.card_id, c.type_line, public.effective_script(p_session_id, p_game_card_id)
    into v_card_id, v_type_line, v_script
  from public.game_cards gc join public.cards c on c.id = gc.card_id
  where gc.id = p_game_card_id and gc.session_id = p_session_id;

  v_is_permanent := v_type_line ilike any (array[
    '%creature%','%artifact%','%enchantment%','%planeswalker%','%battle%','%land%']);

  if v_is_permanent then
    -- Real cast: push a cast_permanent stack item from exile (mirrors
    -- cast_card_from_hand:480-515, minus payment). Resolves with true ETBs.
    select coalesce(max(position), -1) + 1 into v_next_position
    from public.game_stack_items where session_id = p_session_id;

    update public.game_cards
    set zone = 'stack', zone_position = v_next_position, is_tapped = false, damage_marked = 0
    where id = p_game_card_id and session_id = p_session_id;

    insert into public.game_stack_items (
      session_id, controller_player_id, source_card_id, action_type, payload, position)
    values (
      p_session_id, p_controller, p_game_card_id, 'cast_permanent',
      jsonb_build_object('timing', 'sorcery', 'card_id', v_card_id, 'type_line', v_type_line, 'free', true),
      v_next_position);

    perform public.enqueue_cast_triggers(p_session_id, p_game_card_id, p_controller); -- Task 5 (no-op until then)
    return null;
  end if;

  -- Instant / sorcery. Task 3 inserts the targeted branch ABOVE this line.
  v_actions := v_script -> 'spell_effect' -> 'actions';
  if v_actions is null or jsonb_typeof(v_actions) <> 'array' then
    -- Unsupported shape → caller bottoms it (fallback). Signal with a sentinel.
    return '00000000-0000-0000-0000-000000000000'::uuid;
  end if;
  perform public.cast_spell_effect(p_session_id, v_actions, p_game_card_id, 0, null, false, true);
  return null;
end;
$$;
grant execute on function public.cast_card_free(uuid, uuid, uuid) to authenticated;
```

Note: `enqueue_cast_triggers` does not exist until Task 5 — comment out that one line for this task, and re-enable it in Task 5. If `effective_script` is not the right accessor, use `c.script` directly (verify against `effective_script.sql`).

- [ ] **Step 5: Generate + sequence the migration**

Run: `node scripts/new-migration.mjs cast_card_free cast_card_free`
Rename to `supabase/migrations/202605010419_cast_card_free.sql`.

- [ ] **Step 6: Run test to verify it passes**

Run: `node scripts/run-tests.mjs cast-card-free`
Expected: PASS (CF1, CF2).

- [ ] **Step 7: Full verification + commit**

```bash
node scripts/run-tests.mjs
rm -f tsconfig.tsbuildinfo && npx tsc --noEmit
git add supabase/functions_src/cast_card_free.sql supabase/migrations/202605010419_cast_card_free.sql tests/fixtures/test-cards.json tests/feature/cast-card-free.test.ts
git commit -m "feat(engine): cast_card_free — free-cast permanents + no-target spells from exile (mig 419)"
```

---

### Task 3: Target adaptor + targeted-spell path + guard relaxation

**Files:**
- Create: `supabase/functions_src/spell_free_cast_target_spec.sql`
- Modify: `supabase/functions_src/cast_card_free.sql` (insert targeted branch)
- Modify: `supabase/functions_src/choose_triggered_ability_targets.sql:42-49` (guard)
- Modify: `supabase/functions_src/choose_triggered_ability_creature_target.sql` (guard — find via grep)
- Test: `tests/feature/cast-card-free-targeted.test.ts`
- Migration: `supabase/migrations/202605010420_free_cast_targets.sql`

**Interfaces:**
- Consumes: `trigger_effects_target_type(jsonb)`, `trigger_effects_target_controller(jsonb)`, `trigger_effects_target_count(jsonb)` (from `enqueue_triggered_ability.sql`).
- Produces: `spell_free_cast_target_spec(p_actions jsonb) returns jsonb` → `{ "required": bool, "target_type": <jsonb|null>, "target_controller": text, "target_count": int }`. And `cast_card_free`'s targeted branch: parks a `game_pending_decisions` row of `decision_type = 'free_cast_target'` carrying a `free_cast_card_id` param + the `target_type`/`target_controller`/`target_count`/`target_required:true` payload keys, and pushes a placeholder `spell_effect` stack item (status `awaiting_decision`) whose resolution reads the chosen target. Returns the decision id.

- [ ] **Step 1: Add fixture** — append to `tests/fixtures/test-cards.json`:

```json
{
  "name": "Cascade Terminate Test",
  "type_line": "Instant",
  "oracle_text": "Destroy target creature.",
  "power_toughness": null,
  "mana_cost": "{B}{R}",
  "script": { "schema_version": 2, "spell_effect": { "actions": [ { "type": "destroy", "target_type": "creature" } ] } }
}
```

- [ ] **Step 2: Write the failing test**

```ts
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => { await ensureTestCards() })

test('CFT1 free-cast of a targeted instant parks a target decision, then resolves on the target', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const victim = await s.spawnCreature('B', 'Grave Shambler Test')
    const terminate = await s.spawn('A', 'Cascade Terminate Test', 'exile')

    const r = await s.client.query<{ decision_id: string }>(
      `select public.cast_card_free($1, $2, $3) as decision_id`, [s.sessionId, terminate, s.playerId('A')])
    const stackItem = await s.topStackItem()
    assert.ok(stackItem, 'a spell stack item is parked awaiting its target')

    // choose the target via the reused trigger-target RPC
    await s.as('A').chooseTriggerTargets(stackItem!.id, [victim])
    await s.as('A').resolveStack()
    assert.equal(await s.zoneOf(victim), 'graveyard')
    assert.equal(await s.zoneOf(terminate), 'graveyard')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node scripts/run-tests.mjs cast-card-free-targeted`
Expected: FAIL — the targeted instant currently returns the fallback sentinel and is never cast (victim stays on battlefield / RPC rejects the non-trigger stack item).

- [ ] **Step 4: Implement the adaptor**

Create `supabase/functions_src/spell_free_cast_target_spec.sql`:

```sql
-- supabase/functions_src/spell_free_cast_target_spec.sql
-- Reads a spell's cast-time target requirement by reusing the trigger-effect target
-- extractors (spell effect actions share the trigger-effect action shape). Returns
-- {required, target_type, target_controller, target_count}. required=false → no target.
create or replace function public.spell_free_cast_target_spec(p_actions jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_tt jsonb;
begin
  if p_actions is null or jsonb_typeof(p_actions) <> 'array' then
    return jsonb_build_object('required', false);
  end if;
  v_tt := public.trigger_effects_target_type(p_actions);
  if v_tt is null then
    return jsonb_build_object('required', false);
  end if;
  return jsonb_build_object(
    'required', true,
    'target_type', v_tt,
    'target_controller', coalesce(public.trigger_effects_target_controller(p_actions), 'any'),
    'target_count', coalesce(public.trigger_effects_target_count(p_actions), 1));
end;
$$;
grant execute on function public.spell_free_cast_target_spec(jsonb) to authenticated;
```

- [ ] **Step 5: Insert the targeted branch in `cast_card_free`**

Replace the no-target spell block from Task 2 with: compute `v_spec := public.spell_free_cast_target_spec(v_actions)`. If `v_spec->>'required'` is false → the existing free `cast_spell_effect` call. If true → push a `spell_effect` stack item at `max(position)+1` with status `awaiting_decision`, payload carrying `effects`, `target_required:true`, `target_type`, `target_controller`, `target_count`, then insert a `game_pending_decisions` row `decision_type := 'free_cast_target'` bound to that stack item. On the chooser RPC writing `target_card_ids`, the item resolves normally (the `spell_effect` handler already reads `target_card_id`). Store the single chosen id into the payload's `target_card_id` at resolution.

```sql
  v_spec := public.spell_free_cast_target_spec(v_actions);
  if not coalesce((v_spec ->> 'required')::boolean, false) then
    perform public.cast_spell_effect(p_session_id, v_actions, p_game_card_id, 0, null, false, true);
    return null;
  end if;
  select coalesce(max(position), -1) + 1 into v_next_position
  from public.game_stack_items where session_id = p_session_id;
  update public.game_cards set zone = 'stack', zone_position = v_next_position
  where id = p_game_card_id and session_id = p_session_id;
  insert into public.game_stack_items (session_id, controller_player_id, source_card_id, action_type, payload, position, status)
  values (p_session_id, p_controller, p_game_card_id, 'spell_effect',
    jsonb_build_object('effects', v_actions, 'controller_player_id', p_controller, 'timing', 'instant',
      'free_cast', true, 'target_required', true,
      'target_type', v_spec -> 'target_type',
      'target_controller', v_spec ->> 'target_controller',
      'target_count', (v_spec ->> 'target_count')::integer),
    v_next_position, 'awaiting_decision')
  returning id into v_stack_item_id;
  return v_stack_item_id;
```

VERIFY (design risk 1): confirm the `spell_effect` resolution handler reads `payload->>'target_card_id'` set by the chooser. Read the `spell_effect` handler (grep `stack_action_handlers` for its `handler_fn`). If it reads `target_card_ids` (array) instead, store both. Pin with CFT1.

- [ ] **Step 6: Relax the two chooser guards**

In `choose_triggered_ability_targets.sql:42`, widen:

```sql
  if v_stack_item.action_type not in ('triggered_ability', 'spell_effect')
    or not (coalesce((v_stack_item.payload ->> 'target_required')::boolean, false)
            or coalesce((v_stack_item.payload ->> 'target_optional')::boolean, false)) then
    raise exception 'Stack item does not require a trigger target';
  end if;
```

Apply the identical `not in (...)` widening to `choose_triggered_ability_creature_target.sql` (locate its guard via grep). Legality checks below are unchanged.

- [ ] **Step 7: Generate migration, run test, verify**

Run: `node scripts/new-migration.mjs free_cast_targets spell_free_cast_target_spec cast_card_free choose_triggered_ability_targets choose_triggered_ability_creature_target`
Rename to `202605010420_free_cast_targets.sql`.
Run: `node scripts/run-tests.mjs cast-card-free-targeted` → Expected PASS (CFT1).

- [ ] **Step 8: Full verification + commit**

```bash
node scripts/run-tests.mjs
rm -f tsconfig.tsbuildinfo && npx tsc --noEmit
git add supabase/functions_src/spell_free_cast_target_spec.sql supabase/functions_src/cast_card_free.sql supabase/functions_src/choose_triggered_ability_targets.sql supabase/functions_src/choose_triggered_ability_creature_target.sql supabase/migrations/202605010420_free_cast_targets.sql tests/fixtures/test-cards.json tests/feature/cast-card-free-targeted.test.ts
git commit -m "feat(engine): free-cast targeted spells — target adaptor + parked target decision (mig 420)"
```

---

### Task 4: `cascade` effect handler + `cascade_cast` decision

**Files:**
- Create: `supabase/functions_src/exile_until_cheaper.sql` (shared helper; refactor decision)
- Modify: `supabase/functions_src/apply_trigger_effects.sql` (refactor the `discover` branch to call the helper; add the `cascade` branch after it)
- Modify: `supabase/functions_src/submit_decision.sql` (add `cascade_cast` to the allowlist line 110; add its handler after `cast_exiled_free` at line 752)
- Test: `tests/feature/cascade-handler.test.ts`
- Migration: `supabase/migrations/202605010421_cascade_handler.sql`

**Interfaces:**
- Consumes: `cast_card_free` (Task 2/3), `bottom_cards_random`, `mana_value`.
- Produces: `exile_until_cheaper(p_session_id uuid, p_controller uuid, p_max_mv integer) returns uuid` — exiles from the top of the controller's library until the first nonland with `mana_value <= p_max_mv`, bottoms the looked-at pile in random order, and returns that card's id (or null if none). Shared by BOTH the refactored `discover` branch and the new `cascade` branch (DRY decision, 2026-07-20).
- Produces: an `apply_trigger_effects` effect `{ "type": "cascade", "cast_mana_value": <int> }` that calls `exile_until_cheaper(..., cast_mana_value - 1)` (strict `<`), then parks a `cascade_cast` decision (may-cast y/n) on the cascade stack item. `submit_decision` `cascade_cast`: on cast → `cast_card_free`; on decline/empty → bottom the found card too.

- [ ] **Step 1: Write the failing test** (drives the handler directly via a hand-built trigger item)

```ts
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => { await ensureTestCards() })

// Enqueue a bare cascade trigger for A with the given MV window, then resolve it.
async function enqueueCascade(s: Scenario, castMv: number) {
  await s.client.query(
    `insert into public.game_stack_items (session_id, controller_player_id, action_type, payload, position, status)
     select $1, $2, 'triggered_ability',
       jsonb_build_object('label','Cascade','controller_player_id',$2,
         'effects', jsonb_build_array(jsonb_build_object('type','cascade','cast_mana_value',$3)),
         'target_required', false, 'timing','triggered'),
       coalesce((select max(position) from public.game_stack_items where session_id=$1), -1)+1, 'pending'`,
    [s.sessionId, s.playerId('A'), castMv])
}

test('CH1 cascade hits the first cheaper nonland and casts it (permanent)', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    // library top→bottom: a land (skipped), then the bear (MV 2 < 4 window)
    await s.spawn('A', 'Grave Shambler Test', 'library') // placeholder nonland below — order controlled by zone_position
    const bear = await s.spawn('A', 'Cascade Bear Test', 'library')
    await enqueueCascade(s, 4)
    await s.as('A').resolveStack() // runs the cascade effect → parks cascade_cast

    const dec = await s.pendingDecision()
    assert.ok(dec && dec.decision_type === 'cascade_cast')
    await s.as('A').submitDecision(dec!.id, { chosen_ids: [ (dec!.options as { game_card_id: string }[])[0].game_card_id ] })
    await s.as('A').resolveStack() // resolve the pushed cast_permanent
    assert.equal(await s.zoneOf(bear), 'battlefield')
  })
})

test('CH2 declining bottoms the found card — never to hand', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bear = await s.spawn('A', 'Cascade Bear Test', 'library')
    await enqueueCascade(s, 4)
    await s.as('A').resolveStack()
    const dec = await s.pendingDecision()
    await s.as('A').submitDecision(dec!.id, { chosen_ids: [] }) // decline
    assert.equal(await s.zoneOf(bear), 'library') // bottomed, still in library
    assert.equal(await s.zoneCount('A', 'hand'), 0)
  })
})

test('CH3 threshold is strict: a card at exactly the cast MV is skipped', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    // Only card is a {1}{G} bear (MV 2). Window MV < 2 → nothing castable.
    await s.spawn('A', 'Cascade Bear Test', 'library')
    await enqueueCascade(s, 2)
    await s.as('A').resolveStack()
    assert.equal(await s.pendingCount(), 0) // nothing parked; effect completed no-op
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/run-tests.mjs cascade-handler`
Expected: FAIL — `cascade` is an unhandled effect type; no decision parked.

- [ ] **Step 3a: Extract the shared `exile_until_cheaper` helper**

Create `supabase/functions_src/exile_until_cheaper.sql`, lifting the exile-until loop + `bottom_cards_random` out of the discover block (lines 854–879):

```sql
-- supabase/functions_src/exile_until_cheaper.sql
-- Shared by discover (mig 253) and cascade (mig 421): exile from the top of the
-- controller's library until the first NONLAND with mana_value <= p_max_mv; bottom
-- the looked-at pile in random order; return the found card's id (or null if none
-- qualified before the library ran out). Callers park their own "cast it?" decision.
create or replace function public.exile_until_cheaper(
  p_session_id uuid, p_controller uuid, p_max_mv integer
) returns uuid language plpgsql security definer set search_path = public
as $$
declare
  v_looked uuid[] := array[]::uuid[]; v_tid uuid := null; v_len integer;
  v_type_line text; v_mana_cost text;
begin
  v_len := (select count(*) from public.game_cards
            where session_id = p_session_id and owner_id = p_controller and zone = 'library');
  while coalesce(array_length(v_looked, 1), 0) + (case when v_tid is null then 0 else 1 end) < v_len loop
    select gc.id, c.type_line, c.mana_cost into v_tid, v_type_line, v_mana_cost
    from public.game_cards gc join public.cards c on c.id = gc.card_id
    where gc.session_id = p_session_id and gc.owner_id = p_controller and gc.zone = 'library'
      and gc.id <> all(v_looked)
    order by gc.zone_position asc, gc.id asc limit 1;
    exit when v_tid is null;
    if v_type_line not ilike '%land%' and public.mana_value(v_mana_cost) <= coalesce(p_max_mv, 0) then
      update public.game_cards gc
      set zone = 'exile', controller_player_id = gc.owner_id, is_tapped = false,
          zone_position = (select coalesce(max(zone_position), -1) + 1 from public.game_cards x
                           where x.session_id = p_session_id and x.owner_id = gc.owner_id and x.zone = 'exile')
      where gc.id = v_tid;
      exit;
    end if;
    v_looked := v_looked || v_tid;
    v_tid := null;
  end loop;
  if coalesce(array_length(v_looked, 1), 0) > 0 then
    perform public.bottom_cards_random(p_session_id, p_controller, v_looked);
  end if;
  return v_tid;
end;
$$;
grant execute on function public.exile_until_cheaper(uuid, uuid, integer) to authenticated;
```

- [ ] **Step 3b: Refactor the `discover` branch to call the helper**

In `apply_trigger_effects.sql`, replace the discover loop body (lines 854–879) with:

```sql
      v_tid := public.exile_until_cheaper(p_session_id, v_controller, coalesce(v_amount, 0));
```

Leave discover's threshold computation (lines 845–853) and its `cast_exiled_free` decision (lines 880–891) unchanged. The existing discover tests are the regression guard — run them in Step 5.

- [ ] **Step 3c: Implement the `cascade` branch** (after the discover branch)

```sql
    elsif v_type = 'cascade' then
      v_tid := public.exile_until_cheaper(p_session_id, v_controller,
        coalesce((v_effect ->> 'cast_mana_value')::integer, 0) - 1); -- strict < via MV-1
      if v_tid is null then v_i := v_i + 1; continue; end if;
      select coalesce(jsonb_agg(jsonb_build_object('game_card_id', gc.id, 'name', c.name)), '[]'::jsonb)
        into v_options
      from public.game_cards gc join public.cards c on c.id = gc.card_id where gc.id = v_tid;
      insert into public.game_pending_decisions (session_id, deciding_player_id, source_stack_item_id, decision_type, prompt, options, min_choices, max_choices, params)
      values (p_session_id, v_controller, p_stack_item_id, 'cascade_cast',
        'Cascade: cast it without paying its mana cost?', v_options, 0, 1,
        jsonb_build_object('found_card_id', v_tid))
      returning id into v_decision_id;
      update public.game_stack_items set status = 'awaiting_decision', payload = payload || jsonb_build_object('resume_index', v_i + 1) where id = p_stack_item_id;
      return v_decision_id;
```

Confirm `v_tid/v_options/v_decision_id/v_controller/v_i/v_effect/v_type` are already in the `apply_trigger_effects` `declare` scope (the discover branch uses them). After Step 3b the discover-only locals `v_looked/v_len/v_filter/v_name` may be newly unused — leave them declared (other branches may use them) or remove only if the compiler warns and no other branch references them.

- [ ] **Step 4: Implement the `cascade_cast` decision handler** in `submit_decision.sql`

Add `'cascade_cast'` to the allowlist at line 110. After the `cast_exiled_free` handler (line 752), add:

```sql
  elsif v_decision.decision_type = 'cascade_cast' then
    -- Cascade "you may cast it." Cast → cast_card_free (true nested cast).
    -- Decline / empty → the found card bottoms with the rest (never to hand).
    if cardinality(v_chosen_ids) > 0 then
      perform public.cast_card_free(v_decision.session_id,
        (v_decision.params ->> 'found_card_id')::uuid, v_decision.deciding_player_id);
    else
      perform public.bottom_cards_random(v_decision.session_id, v_decision.deciding_player_id,
        array[(v_decision.params ->> 'found_card_id')::uuid]);
    end if;
    perform public.resume_or_finalize(v_decision.session_id, v_decision.source_stack_item_id);
```

VERIFY (design risk 2): after `cast_card_free` pushes the found spell/permanent above the cascade item, confirm `resume_or_finalize` finalizes the cascade item but leaves the pushed item pending so the next `resolveStack` resolves it. CH1's second `resolveStack()` pins this.

- [ ] **Step 5: Generate migration, run test**

Run: `node scripts/new-migration.mjs cascade_handler exile_until_cheaper apply_trigger_effects submit_decision`
Rename to `202605010421_cascade_handler.sql`.
Run the discover regression guard first: `node scripts/run-tests.mjs discover` → Expected PASS (unchanged).
Run: `node scripts/run-tests.mjs cascade-handler` → Expected PASS (CH1–CH3).

- [ ] **Step 6: Full verification + commit**

```bash
node scripts/run-tests.mjs
rm -f tsconfig.tsbuildinfo && npx tsc --noEmit
git add supabase/functions_src/exile_until_cheaper.sql supabase/functions_src/apply_trigger_effects.sql supabase/functions_src/submit_decision.sql supabase/migrations/202605010421_cascade_handler.sql tests/feature/cascade-handler.test.ts
git commit -m "feat(engine): cascade effect handler + shared exile_until_cheaper + cascade_cast decision (mig 421)"
```

---

### Task 5: `enqueue_cast_triggers` + wire into the cast paths + `cascade` script marker

**Files:**
- Create: `supabase/functions_src/enqueue_cast_triggers.sql`
- Modify: `supabase/functions_src/cast_card_from_hand.sql:519` (call after the `spell_cast` fire)
- Modify: `supabase/functions_src/cast_spell_effect.sql:245` (call after the `spell_cast` fire)
- Modify: `supabase/functions_src/cast_card_free.sql` (re-enable the call from Task 2)
- Test: `tests/feature/cascade-cast-hook.test.ts`
- Migration: `supabase/migrations/202605010422_enqueue_cast_triggers.sql`

**Interfaces:**
- Consumes: `enqueue_triggered_ability`, `mana_value`.
- Produces: `enqueue_cast_triggers(p_session_id uuid, p_card_id uuid, p_controller uuid) returns void` — reads the just-cast card's `script.cascade` (`{count:N}` or `true`) and enqueues N cascade triggers via `enqueue_triggered_ability(..., '[{"type":"cascade","cast_mana_value":<castMV>}]')`, where castMV = `mana_value(card.mana_cost)`.

- [ ] **Step 1: Add cascade to a fixture** — append to `tests/fixtures/test-cards.json`:

```json
{
  "name": "Cascade Wurm Test",
  "type_line": "Creature - Wurm",
  "oracle_text": "Cascade",
  "power_toughness": "5/5",
  "mana_cost": "{4}{G}",
  "script": { "schema_version": 2, "cascade": { "count": 1 } }
}
```

- [ ] **Step 2: Write the failing test**

```ts
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => { await ensureTestCards() })

test('CX1 casting a cascade permanent enqueues a cascade trigger', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bear = await s.spawn('A', 'Cascade Bear Test', 'library') // MV 2 < 5 window
    const wurm = await s.spawn('A', 'Cascade Wurm Test', 'hand')    // {4}{G} = MV 5
    await s.setMana('A', { G: 1, C: 4 })
    await s.as('A').castPermanent(wurm)

    const stack = await s.pendingStack()
    const cascade = stack.find((i) => i.action_type === 'triggered_ability'
      && Array.isArray((i.payload.effects as unknown[]))
      && JSON.stringify(i.payload.effects).includes('"cascade"'))
    assert.ok(cascade, 'a cascade trigger is on the stack above the wurm')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node scripts/run-tests.mjs cascade-cast-hook`
Expected: FAIL — no cascade trigger enqueued (function absent / not wired).

- [ ] **Step 4: Implement `enqueue_cast_triggers`**

```sql
-- supabase/functions_src/enqueue_cast_triggers.sql
create or replace function public.enqueue_cast_triggers(
  p_session_id uuid, p_card_id uuid, p_controller uuid
) returns void language plpgsql security definer set search_path = public
as $$
declare
  v_script jsonb; v_mana_cost text; v_mv integer; v_count integer; v_i integer;
begin
  select public.effective_script(p_session_id, p_card_id), c.mana_cost
    into v_script, v_mana_cost
  from public.game_cards gc join public.cards c on c.id = gc.card_id
  where gc.id = p_card_id and gc.session_id = p_session_id;

  if v_script -> 'cascade' is null then return; end if;

  v_mv := public.mana_value(v_mana_cost);
  v_count := case
    when jsonb_typeof(v_script -> 'cascade') = 'object'
      then coalesce((v_script -> 'cascade' ->> 'count')::integer, 1)
    else 1 end;

  for v_i in 1 .. greatest(1, v_count) loop
    perform public.enqueue_triggered_ability(
      p_session_id, p_controller, p_card_id, 'Cascade',
      jsonb_build_array(jsonb_build_object('type', 'cascade', 'cast_mana_value', v_mv)));
  end loop;
end;
$$;
grant execute on function public.enqueue_cast_triggers(uuid, uuid, uuid) to authenticated;
```

- [ ] **Step 5: Wire it into the three cast paths**

In `cast_card_from_hand.sql` after line 519 (`fire_watcher_triggers(..., 'spell_cast')`):
```sql
  perform public.enqueue_cast_triggers(p_session_id, p_game_card_id, auth.uid());
```
In `cast_spell_effect.sql` inside the `if p_source_card_id is not null then` block after line 244:
```sql
    perform public.enqueue_cast_triggers(p_session_id, p_source_card_id, auth.uid());
```
In `cast_card_free.sql`, re-enable the `enqueue_cast_triggers` call in the permanent branch (commented in Task 2).

- [ ] **Step 6: Generate migration, run test**

Run: `node scripts/new-migration.mjs enqueue_cast_triggers enqueue_cast_triggers cast_card_from_hand cast_spell_effect cast_card_free`
Rename to `202605010422_enqueue_cast_triggers.sql`.
Run: `node scripts/run-tests.mjs cascade-cast-hook` → Expected PASS (CX1).

- [ ] **Step 7: Full verification + commit**

```bash
node scripts/run-tests.mjs
rm -f tsconfig.tsbuildinfo && npx tsc --noEmit
git add supabase/functions_src/enqueue_cast_triggers.sql supabase/functions_src/cast_card_from_hand.sql supabase/functions_src/cast_spell_effect.sql supabase/functions_src/cast_card_free.sql supabase/migrations/202605010422_enqueue_cast_triggers.sql tests/fixtures/test-cards.json tests/feature/cascade-cast-hook.test.ts
git commit -m "feat(engine): enqueue_cast_triggers — fire cascade from every cast path (mig 422)"
```

---

### Task 6: End-to-end + recursion + multi-cascade tests

**Files:**
- Test: `tests/feature/cascade-e2e.test.ts`
- (No engine change expected; if a test fails, fix forward and note the migration.)

**Interfaces:**
- Consumes: everything from Tasks 1–5.

- [ ] **Step 1: Add a recursive-cascade fixture** — append to `tests/fixtures/test-cards.json`:

```json
{
  "name": "Cascade Chain Test",
  "type_line": "Sorcery",
  "oracle_text": "Cascade. Draw a card.",
  "power_toughness": null,
  "mana_cost": "{2}{U}",
  "script": { "schema_version": 2, "cascade": { "count": 1 }, "spell_effect": { "actions": [ { "type": "draw", "count": 1 } ] } }
}
```

- [ ] **Step 2: Write the tests**

```ts
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { withRolledBackTx } from '../harness/db'
import { Scenario } from '../harness/scenario'
import { ensureTestCards } from '../harness/seed'

before(async () => { await ensureTestCards() })

// E2E1 full flow: cast a cascade spell from hand, resolve the cascade trigger,
// accept the may-cast, and see the found permanent enter.
test('E2E1 cast-from-hand cascade casts a cheaper permanent', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    const bear = await s.spawn('A', 'Cascade Bear Test', 'library')
    const wurm = await s.spawn('A', 'Cascade Wurm Test', 'hand')
    await s.setMana('A', { G: 1, C: 4 })
    await s.as('A').castPermanent(wurm)
    await s.as('A').resolveStack() // cascade trigger → parks cascade_cast
    const dec = await s.pendingDecision()
    assert.equal(dec!.decision_type, 'cascade_cast')
    await s.as('A').submitDecision(dec!.id, { chosen_ids: [(dec!.options as { game_card_id: string }[])[0].game_card_id] })
    await s.as('A').resolveStack() // resolve the found permanent
    assert.equal(await s.zoneOf(bear), 'battlefield')
  })
})

// E2E2 recursion: cascade finds a cascade spell, which cascades again.
test('E2E2 a found cascade spell cascades again', async () => {
  await withRolledBackTx(async (client) => {
    const s = await Scenario.create(client)
    await s.setTurn({ phase: 'main_1', step: 'precombat_main', active: 'A', priority: 'A' })
    // library top→bottom: Chain (MV3 <5), then Bear (MV2 <3)
    const chain = await s.spawn('A', 'Cascade Chain Test', 'library')
    const bear = await s.spawn('A', 'Cascade Bear Test', 'library')
    const wurm = await s.spawn('A', 'Cascade Wurm Test', 'hand') // MV5
    await s.setMana('A', { G: 1, C: 4 })
    await s.as('A').castPermanent(wurm)
    await s.as('A').resolveStack()
    let dec = await s.pendingDecision()
    await s.as('A').submitDecision(dec!.id, { chosen_ids: [(dec!.options as { game_card_id: string }[])[0].game_card_id] }) // cast Chain
    await s.as('A').resolveStack() // Chain's own cascade trigger fires → parks again
    dec = await s.pendingDecision()
    assert.equal(dec!.decision_type, 'cascade_cast')
    await s.as('A').submitDecision(dec!.id, { chosen_ids: [(dec!.options as { game_card_id: string }[])[0].game_card_id] }) // cast Bear
    await s.as('A').resolveStack()
    assert.equal(await s.zoneOf(bear), 'battlefield')
  })
})
```

- [ ] **Step 3: Run + fix forward**

Run: `node scripts/run-tests.mjs cascade-e2e`
If E2E2 reveals an ordering problem (design risk 2), fix `resume_or_finalize`/handler ordering in the relevant function, regenerate its migration as `202605010423_<name>.sql`, and re-run.

- [ ] **Step 4: Commit**

```bash
node scripts/run-tests.mjs
git add tests/fixtures/test-cards.json tests/feature/cascade-e2e.test.ts
git commit -m "test(engine): cascade end-to-end + recursion coverage"
```

---

### Task 7: Cascade in the authoring schema

**Files:**
- Modify: `lib/game/card-behavior-schema.ts` (add the `cascade` field to the card-script schema)
- Test: `tests/unit/registry-schema-drift.test.ts` (extend if it enumerates script fields)

**Interfaces:**
- Produces: a validated optional `cascade` script field: `z.union([z.literal(true), z.object({ count: z.number().int().positive() }).strict()]).optional()`.

- [ ] **Step 1: Locate the top-level card-script object** in `card-behavior-schema.ts` (grep for `spell_effect:` in a `z.object`). Add:

```ts
  // Cascade (mig 421-422): a cast-time self-trigger. `true` = one instance;
  // `{count}` for Apex Devastator (4) / Maelstrom Wanderer (2).
  cascade: z.union([z.literal(true), z.object({ count: z.number().int().positive() }).strict()]).optional(),
```

- [ ] **Step 2: Typecheck + drift guard**

Run: `rm -f tsconfig.tsbuildinfo && npx tsc --noEmit`
Run: `node scripts/run-tests.mjs registry-schema-drift`
Expected: PASS. If the drift test enumerates known fields, add `cascade` there.

- [ ] **Step 3: Commit**

```bash
git add lib/game/card-behavior-schema.ts tests/unit/registry-schema-drift.test.ts
git commit -m "feat(schema): cascade script field"
```

---

### Task 8: Card scripts for the ~34 intrinsic-cascade cards

**Files:**
- Create/modify: card-script entries (the bulk-scripting flow — `scripts/upsert-deck-scripts.mjs` reads a card list; scripts authored in the card-scripts source the repo uses — locate via `grep -rl "card-scripts" scripts lib`).
- Validate: `node scripts/validate-card-scripts.mts`

**Interfaces:**
- Consumes: the `cascade` schema field (Task 7).

- [ ] **Step 1: Add `cascade` to each plain card's script.** For the 29 plain cards, add `"cascade": true` alongside their existing script. For multi-cascade: `"cascade": { "count": 4 }` (Apex Devastator), `{ "count": 2 }` (Maelstrom Wanderer). Plain list (verbatim): Annoyed Altisaur, Ardent Plea, Bituminous Blast, Bloodbraid Elf, Boarding Party, Captured Sunlight, Demonic Dread, Deny Reality, Enigma Sphinx, Enlisted Wurm, Etherium-Horn Sorcerer, Ethersworn Sphinx, Forceful Denial, Garbage Elemental, Heralds of Tzeentch, Ingenuity Engine, Into the Time Vortex, Kathari Remnant, Let the Galaxy Burn, Maelstrom Colossus, Meteoric Mace, Natural Reclamation, Noise Marine, Sakashima's Protege, Shardless Agent, Stormcaller's Boon, Throes of Chaos, Violent Outburst, Volcanic Torrent.

- [ ] **Step 2: Per-card check the four `?`-flagged cards** (Bigger on the Inside, Bloodbraid Challenger, Bloodbraid Marauder, Sweet-Gum Recluse) against their oracle text: add intrinsic `cascade` only where the card literally *has* cascade; if it *grants* cascade, leave for the deferred granted-cascade feature.

- [ ] **Step 3: Validate**

Run: `node scripts/validate-card-scripts.mts`
Expected: no schema errors.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(cards): intrinsic cascade on 34 cards"
```

---

### Task 9: Deploy

- [ ] **Step 1: Full suite + typecheck + lint (green)**

```bash
node scripts/run-tests.mjs
rm -f tsconfig.tsbuildinfo && npx tsc --noEmit
npx eslint .
```

- [ ] **Step 2: Diff-check every new migration** code-only vs its latest `create or replace` (strip `--` lines).

- [ ] **Step 3: Release + deploy** (per hosting-ovhcloud): `gh release create vX --target master` → `deploy.yml` db-pushes migrations 418–422 + rebuilds the VPS.

- [ ] **Step 4: Push card scripts to the hosted DB:**

```bash
node --import tsx scripts/upsert-deck-scripts.mjs <all-cards-deck.txt> --apply --force
```

- [ ] **Step 5: Verify** — re-dry-run shows 0 diffs; site returns 200; spot-check a cascade card in a live game.

---

## Self-Review

**Spec coverage:**
- §3 `cast_card_free` → Tasks 2, 3. `spell_free_cast_target_spec` → Task 3. `enqueue_cast_triggers` → Task 5. `cascade` handler → Task 4. `cascade` marker → Tasks 5, 7. Free-cast payment skip → Task 1 (the spec implied "free by construction"; implementation revealed exile casts DO charge, so `p_free` is a required addition — documented in Task 1's interface).
- §4 target-parking → Task 3; guard relaxation → Task 3 Step 6; resolution ordering → Tasks 4/6 (design risk 2, pinned by CH1/E2E2).
- §5 representation → Tasks 5, 7. §6 fallback taxonomy → Task 2 (sentinel), Task 4 (`cascade_cast` decline → bottom). §7 rollout → Task 8. §8 testing → Tasks 1–6. §9 deploy → Task 9.
- Deferred items (granted-cascade, cascade-payoff, as-you-cascade) correctly have NO task — out of scope per spec §2.

**Placeholder scan:** No TBD/TODO. Two explicit VERIFY points (Task 3 Step 5, Task 4 Step 4) are design risks from the spec, each pinned to a named test — these are verification instructions, not placeholders.

**Type consistency:** `cast_card_free(uuid,uuid,uuid) returns uuid` used identically in Tasks 2/3/4. `enqueue_cast_triggers(uuid,uuid,uuid)` consistent Tasks 5. Effect key `cast_mana_value` consistent Tasks 4/5. Decision types `cascade_cast` (Task 4) and `free_cast_target` (Task 3) distinct and consistent. `p_free` 7th arg of `cast_spell_effect` consistent Tasks 1/2/3.

**Known adaptation risk (flagged, not hidden):** the exact `declare`-scope variable names in `apply_trigger_effects` (`v_amount`, `v_looked`, etc.) and the precise `spell_effect` resolution handler's target key are asserted from the discover block but must be confirmed against the file at implementation time (Task 4 Step 3 note, Task 3 Step 5 VERIFY). If `effective_script` is not the canonical script accessor, Tasks 2/5 fall back to `cards.script`.
