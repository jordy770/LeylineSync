// Generate a migration from canonical function sources.
//
//   node scripts/new-migration.mjs 202605010203_player_hexproof_gate put_action_on_stack [...]
//
// Workflow for changing an engine function:
//   1. Edit supabase/functions_src/<fn>.sql (git diff shows exactly your change).
//   2. Run this to emit supabase/migrations/<name>.sql containing each named
//      source verbatim (minus the canonical-file banner).
//   3. Hand-add any non-function DDL (CHECK constraints, columns, tables) at the
//      top of the generated migration — functions_src is canonical for FUNCTIONS
//      only. Then add your own header comment describing the change.
//   4. npm run test:db:setup && npm test.
//
// Refuses to overwrite an existing migration.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const [name, ...fns] = process.argv.slice(2)
if (!name || fns.length === 0) {
  console.error('usage: node scripts/new-migration.mjs <migration_name> <fn> [<fn> ...]')
  process.exit(1)
}

const root = process.cwd()
const outPath = path.join(root, 'supabase', 'migrations', `${name}.sql`)
if (existsSync(outPath)) {
  console.error(`refusing to overwrite ${outPath}`)
  process.exit(1)
}

const parts = []
for (const fn of fns) {
  const srcPath = path.join(root, 'supabase', 'functions_src', `${fn}.sql`)
  const text = readFileSync(srcPath, 'utf8')
  // Drop the canonical-file banner (everything before the first create/alter/drop).
  const start = text.search(/^(create|alter|drop) /m)
  parts.push(text.slice(start === -1 ? 0 : start).trimEnd())
}

const header = `-- ${name}\n-- TODO: describe the change.\n-- Generated from supabase/functions_src (${fns.join(', ')}) — those files are\n-- the canonical current definitions; edit them, not past migrations.\n\n`
writeFileSync(outPath, header + parts.join('\n\n') + '\n')
console.log(`wrote ${outPath} (${fns.length} function(s))`)
