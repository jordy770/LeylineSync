// One-shot seeder for supabase/functions_src/: finds each named function's
// LATEST definition across supabase/migrations/*.sql (and the local-bootstrap
// baseline as a fallback) and writes it — definition + its immediate grant
// lines — to supabase/functions_src/<name>.sql.
//
// Extraction is dollar-quote-aware: the body opens at `as $TAG$` (tags like $$
// or $_$) and closes at the line `$TAG$;` — NOT at the first bare `$$;`, which
// over-captures when a body uses a tagged quote (pay_mana_cost in mig 109 closes
// with `$_$;`). Handles both migration style (`create or replace function
// public.fn(`) and the pg_dump baseline style (`CREATE OR REPLACE FUNCTION
// "public"."fn"(`). Takes the LAST definition in the LAST file that has one.
//
// Verify after seeding: apply every functions_src file to the local DB
// (create-or-replace is idempotent) and run the full suite.

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const FUNCTIONS = process.argv.slice(2)
if (FUNCTIONS.length === 0) {
  console.error('usage: node scripts/extract-functions.mjs <fn> [<fn> ...]')
  process.exit(1)
}

const root = process.cwd()
const migDir = path.join(root, 'supabase', 'migrations')
const bootDir = path.join(root, 'supabase', 'local-bootstrap')
const outDir = path.join(root, 'supabase', 'functions_src')
mkdirSync(outDir, { recursive: true })

const sources = [
  ...readdirSync(bootDir).filter((f) => f.endsWith('.sql')).sort().map((f) => path.join(bootDir, f)),
  ...readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort().map((f) => path.join(migDir, f)),
]

function lastMatchIndex(re, text) {
  let last = -1
  for (const m of text.matchAll(re)) last = m.index
  return last
}

function extract(fnName, text) {
  const starts = [
    new RegExp(`^create or replace function public\\.${fnName}\\(`, 'gm'),
    new RegExp(`^CREATE OR REPLACE FUNCTION "public"\\."${fnName}"\\(`, 'gm'),
  ]
  const idx = Math.max(...starts.map((re) => lastMatchIndex(re, text)))
  if (idx < 0) return null

  // Body delimiter: the first `AS $tag$` after the header.
  const openRe = /\b[Aa][Ss]\s+(\$[A-Za-z_]*\$)/g
  openRe.lastIndex = idx
  const open = openRe.exec(text)
  if (!open) return null
  const tag = open[1]
  const close = text.indexOf('\n' + tag + ';', open.index + open[0].length)
  if (close < 0) return null
  let end = close + 1 + tag.length + 1 // past "\n$tag$;"

  let def = text.slice(idx, end + 1)
  if (!def.endsWith('\n')) def += '\n'

  // Immediately-following grant lines for THIS function (migration style).
  const rest = text.slice(end + 1).split('\n')
  const grants = []
  for (const line of rest) {
    if (line.trim() === '' && grants.length === 0) continue
    if (line.startsWith(`grant execute on function public.${fnName}`)) {
      grants.push(line)
      continue
    }
    break
  }
  if (grants.length > 0) def += grants.join('\n') + '\n'
  return def
}

for (const fn of FUNCTIONS) {
  let found = null
  let from = null
  for (const file of sources) {
    const text = readFileSync(file, 'utf8')
    const def = extract(fn, text)
    if (def !== null) {
      found = def
      from = path.basename(file)
    }
  }
  if (!found) {
    console.error(`NOT FOUND: ${fn}`)
    process.exitCode = 1
    continue
  }
  const banner = `-- supabase/functions_src/${fn}.sql\n-- CANONICAL current definition (seeded from ${from}).\n-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —\n-- never re-extract from past migrations.\n\n`
  writeFileSync(path.join(outDir, `${fn}.sql`), banner + found)
  const count = (found.match(/create or replace function|CREATE OR REPLACE FUNCTION/g) || []).length
  console.log(`${fn}: from ${from} (${found.split('\n').length} lines, ${count} create stmt)`)
}
