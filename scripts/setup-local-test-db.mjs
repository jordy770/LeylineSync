// Rebuilds the LOCAL test-harness database from scratch.
//
// Why this exists: supabase/migrations/ holds ONLY the real incremental
// migrations (087+) so `supabase db push` is safe to run against hosted. The full
// schema baseline and the local-only relax-FK migration live in
// supabase/local-bootstrap/ — OUT of the push path so they can never reach prod
// (the baseline would collide with the existing hosted schema; the relax-FK drops
// production foreign keys). `supabase db reset` can't build local on its own
// anymore (the incrementals assume the base tables exist), so this script does it:
//
//   1. drop & recreate the public schema (clean slate)
//   2. apply supabase/local-bootstrap/*.sql in name order (baseline, then relax-FK)
//   3. apply supabase/migrations/*.sql in name order (087 … latest)
//
// Run against a running local Supabase (`npx supabase start`):  npm run test:db:setup
// Override the target with TEST_DATABASE_URL.

import { Client } from 'pg'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

// The test harness lives in its OWN database so the play DB (`postgres`, what the
// app/Supabase API uses on :54322) is never wiped by a schema rebuild. Override
// with TEST_DATABASE_URL. The maintenance DB (`postgres`) is only used to CREATE
// the test DB if it doesn't exist yet.
const TEST_DB = process.env.TEST_DB_NAME ?? 'leyline_test'
const MAINTENANCE = process.env.TEST_MAINTENANCE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const CONNECTION =
  process.env.TEST_DATABASE_URL ?? `postgresql://postgres:postgres@127.0.0.1:54322/${TEST_DB}`

// Supabase's GoTrue installs auth.uid() in the `postgres` DB only; a fresh test DB
// has no `auth` schema, so the engine (which calls auth.uid()) would break. Stub it
// to read the same request.jwt.claims->>'sub' the harness sets — identical behaviour.
const AUTH_STUB = `
-- Rebuilt from scratch each run (the auth schema survives a public-schema drop, so
-- "if not exists" would keep a stale stub shape).
drop schema if exists auth cascade;
create schema auth;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid
$$;
-- The baseline's FKs reference auth.users (GoTrue's table, absent in a fresh DB).
-- A minimal stub lets those FKs build; 01_relax_fks.sql drops them right after.
create table auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb
);
grant usage on schema auth to anon, authenticated, service_role;
-- A migration adds tables to Supabase's realtime publication; create it if absent.
do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
`

const root = process.cwd()
const bootstrapDir = path.join(root, 'supabase', 'local-bootstrap')
const migrationsDir = path.join(root, 'supabase', 'migrations')

function sqlFiles(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => path.join(dir, f))
}

// Clean slate. The baseline dump uses CREATE ... IF NOT EXISTS and is not safe to
// re-run over an existing schema, so we drop public first. Supabase's extensions,
// auth, and storage schemas are untouched (the app schema is public).
const RESET_PUBLIC = `
drop schema if exists public cascade;
create schema public;
alter schema public owner to pg_database_owner;
grant usage on schema public to anon, authenticated, service_role;
grant all on schema public to postgres, service_role;
`

// Create the test DB on the cluster if it isn't there yet (CREATE DATABASE can't
// run in a transaction, so use a dedicated maintenance connection).
async function ensureDatabase(name) {
  const admin = new Client({ connectionString: MAINTENANCE })
  await admin.connect()
  try {
    const { rowCount } = await admin.query('select 1 from pg_database where datname = $1', [name])
    if (rowCount === 0) {
      process.stdout.write(`Creating database ${name}... `)
      await admin.query(`create database "${name}"`)
      console.log('ok')
    }
  } finally {
    await admin.end()
  }
}

async function main() {
  const files = [...sqlFiles(bootstrapDir), ...sqlFiles(migrationsDir)]

  // Footgun guard: this script DROPs the public schema. Refuse to do that to the
  // play DB (`postgres`) unless explicitly forced — that wipe is exactly what this
  // change exists to prevent.
  const targetDb = decodeURIComponent(new URL(CONNECTION).pathname.replace(/^\//, ''))
  if (targetDb === 'postgres' && !process.argv.includes('--force-play-db')) {
    console.error(
      `Refusing to rebuild the '${targetDb}' database — that is the play DB the app uses.\n` +
      `Tests run against '${TEST_DB}'. Set TEST_DATABASE_URL to override, or pass --force-play-db if you really mean it.`,
    )
    process.exit(1)
  }

  await ensureDatabase(targetDb)

  const client = new Client({ connectionString: CONNECTION })
  await client.connect()
  try {
    process.stdout.write('Resetting public schema... ')
    await client.query(RESET_PUBLIC)
    console.log('ok')

    process.stdout.write('Installing auth.uid() stub... ')
    await client.query(AUTH_STUB)
    console.log('ok')

    for (const file of files) {
      const rel = path.relative(root, file)
      process.stdout.write(`Applying ${rel} ... `)
      // STRICT UTF-8 check before applying. Node's 'utf8' read silently
      // replaces invalid bytes (so a Windows-1252 em-dash would apply fine
      // locally), but `supabase db push` sends raw bytes and hosted Postgres
      // rejects them (SQLSTATE 22021). Fail HERE, not at prod push time.
      const raw = readFileSync(file)
      let sql
      try {
        sql = new TextDecoder('utf-8', { fatal: true }).decode(raw)
      } catch {
        throw new Error(
          `${rel} is not valid UTF-8 (probably written with the Windows ` +
          `locale encoding — re-save it as UTF-8). Hosted db push would reject it.`,
        )
      }
      await client.query(sql)
      console.log('ok')
    }
  } finally {
    await client.end()
  }

  console.log(`\nLocal test DB ready (${files.length} files applied).`)
}

main().catch((err) => {
  console.error('\nSetup failed:', err.message)
  process.exit(1)
})
