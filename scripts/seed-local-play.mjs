// Make the LOCAL play database (the `postgres` DB the Supabase API/app uses on
// :54322) playable again after it's been emptied — e.g. by a `supabase db reset`.
// Tests now live in their own `leyline_test` DB (see setup-local-test-db.mjs), so
// this is only needed when the play DB itself gets wiped.
//
// Runs, in order, the existing seeders (each targets whatever .env.local points
// at / the local pg):
//   1. import:cards         — full catalog from the local oracle JSON
//   2. seed-scripts-local   — behaviour scripts + basic-land mana onto the catalog
//   3. deck:seed-precons    — shared precon decks from docs/commander-decks/*.txt
//
//   node scripts/seed-local-play.mjs
//
// HARD SAFETY: refuses to run unless NEXT_PUBLIC_SUPABASE_URL is local — importing
// 31k cards into hosted would be a mess.

import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'

function loadEnv(file) {
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
loadEnv('.env')
loadEnv('.env.local')

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? ''
if (!/(localhost|127\.0\.0\.1)/.test(url)) {
  console.error(`Refusing to run: NEXT_PUBLIC_SUPABASE_URL ("${url}") is not local.\n` +
    `Point .env.local at local Supabase (http://127.0.0.1:54321) first.`)
  process.exit(1)
}

const steps = [
  { label: 'Import catalog (import:cards)', cmd: [process.execPath, 'scripts/import-scryfall-cards.mjs'] },
  { label: 'Seed scripts + basic lands', cmd: [process.execPath, '--import', 'tsx', 'scripts/seed-scripts-local.mjs'] },
  { label: 'Seed precon decks', cmd: [process.execPath, '--import', 'tsx', 'scripts/seed-precon-decks.mjs', '--apply'] },
]

console.log(`Seeding the LOCAL play DB (${url})\n`)
for (const [i, step] of steps.entries()) {
  console.log(`\n── [${i + 1}/${steps.length}] ${step.label} ──`)
  const r = spawnSync(step.cmd[0], step.cmd.slice(1), { stdio: 'inherit', cwd: process.cwd() })
  if (r.status !== 0) {
    console.error(`\nStep failed: ${step.label} (exit ${r.status}). Stopping.`)
    process.exit(r.status ?? 1)
  }
}
console.log('\n✓ Local play DB is ready: catalog imported, scripts + basics applied, precons seeded.')
