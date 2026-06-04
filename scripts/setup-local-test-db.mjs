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

const CONNECTION =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

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

async function main() {
  const files = [...sqlFiles(bootstrapDir), ...sqlFiles(migrationsDir)]

  const client = new Client({ connectionString: CONNECTION })
  await client.connect()
  try {
    process.stdout.write('Resetting public schema... ')
    await client.query(RESET_PUBLIC)
    console.log('ok')

    for (const file of files) {
      const rel = path.relative(root, file)
      process.stdout.write(`Applying ${rel} ... `)
      await client.query(readFileSync(file, 'utf8'))
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
