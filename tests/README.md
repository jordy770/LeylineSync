# Rules-engine test harness (the "test chamber")

Programmatic regression + interaction tests for the plpgsql rules engine. Tests
drive the **real RPCs** (`put_action_on_stack`, `resolve_top_of_stack`,
`activate_ability`, the `dev_*` setup helpers …) against a **local Supabase**
Postgres and assert on resulting game state — the same path the app takes.

## Why it's built this way

- **Direct `pg` connection, not supabase-js.** The RPCs gate on `auth.uid()`,
  which resolves from `request.jwt.claims ->> 'sub'`. Only a raw connection can
  set that GUC on the same connection before the call (see `harness/db.ts`,
  `asPlayer`). Bonus: each test runs in a transaction that is **rolled back**, so
  tests are isolated with no `db reset` between them.
- **Setup via existing `dev_*` RPCs** (`dev_spawn_card`, `dev_set_turn_state`,
  `dev_clear_summoning_sickness`).

## How the local schema is built (important)

The incremental migrations in `supabase/migrations_archive/` were authored on top
of a base schema created out-of-band on the hosted project, and several functions
change their return type via `create or replace` — so the chain **cannot be
replayed from scratch** (and Supabase's version-keying makes mid-chain fix-shims
impossible). Instead local uses a **squashed baseline**:

- `supabase/migrations/00000000000000_baseline.sql` — full hosted schema dump
  (reproduces prod exactly, incl. migrations 079–086).
- `supabase/migrations/00000000000001_local_test_relax_fks.sql` — **LOCAL ONLY**:
  drops the `auth.users` / `profiles` FKs so the harness can use throwaway player
  UUIDs without seeding auth users. **Do not apply this one to hosted.**

The 88 original incremental files live in `supabase/migrations_archive/` as history
(Supabase does not apply them). New migrations still go in `supabase/migrations/`.
The `% Test` cards are seeded from `tests/fixtures/test-cards.json` by the harness
(`ensureTestCards`) — the dump is schema-only, so the catalog starts empty.

## One-time setup

1. **Start Docker Desktop** (the engine must be running).
2. Start the local stack + apply the baseline (Supabase CLI runs via `npx`):
   ```sh
   npx supabase start
   npx supabase db reset    # rebuilds from the baseline; re-run after migration changes
   ```
3. Install dev deps (`pg`, `@types/pg`, `tsx`):
   ```sh
   npm install
   ```

Local DB defaults to `postgresql://postgres:postgres@127.0.0.1:54322/postgres`.
Override with `TEST_DATABASE_URL` if `supabase start` reports a different port.

## Running

```sh
npm test
```

(Node's `--test` glob isn't reliable on Windows, so `package.json` points at the
file explicitly; add new test files to the `test` script as they're created.)

## Gotchas learned wiring this up

- Turn **phases** are `beginning | main_1 | combat | main_2 | ending`; **steps**
  are separate (`untap`, `upkeep`, `draw`, `precombat_main`, …). `Scenario.setTurn`
  takes both — a main-phase instant window is `{ phase: 'main_1', step: 'precombat_main' }`.
- `resolve_top_of_stack` can be called directly (no priority-pass needed).
- `asPlayer` cleanup is wrapped in try/catch so a failed RPC's real error isn't
  masked by `25P02` on an aborted transaction.

## Layout

- `harness/db.ts` — connection, `withRolledBackTx`, `asPlayer` (the auth trick), `rpc`.
- `harness/scenario.ts` — `Scenario`: `create`, `spawn`/`spawnCreature`, `setTurn`,
  `as(seat).putOnStack/activate`, `resolveStack`, and inspectors (`zoneOf`,
  `cardState`, `lifeOf`, `zoneCount`, `pendingStack`).
- `harness/seed.ts` — `ensureTestCards` (seeds the catalog from the fixture).
- `fixtures/test-cards.json` — the `% Test` card definitions.
- `regression/group1.test.ts` — the 084/085/086 regression net. **All 12 green**
  (R1–R12: destroy spell/combat/trigger, bounce, tap/untap, counters, pump, draw,
  dies-trigger, activated ability, continuous effects, counter_spell).

## Status

✅ **24/24 green.** Regression (Group 1, R1–R12) + feature groups:

- `feature/targeted-triggers.test.ts` — 080/081: targeted ETB destroy, ownership
  restriction, no-softlock fizzle, bug-098 recipient auto-resolve.
- `feature/trigger-events.test.ts` — 082: leaves-the-battlefield, draw/end step,
  blocks, becomes-targeted (lands above the targeting spell, no loop).
- `feature/exile-mill.test.ts` — 083: spell exile, targeted-trigger exile, mill.

Not covered (out of harness scope): the malformed Giant Growth / Lightning Strike
seed scripts — that's a client `getSpellPlan` classification concern, not an engine
RPC, so it can't surface through `put_action_on_stack`. Verify those in the app.
