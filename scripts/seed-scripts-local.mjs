// Apply behaviour scripts onto the LOCAL card catalog by name, so real-named
// cards (e.g. "Haven of the Spirit Dragon") actually do their thing in a local
// game. After `import:cards`, local has 31k+ catalog rows but almost no `script`
// (scripts only reach a catalog via deck:upsert, which defaults to HOSTED) — so
// real decks import inert cards. This is the local counterpart of deck:upsert.
//
// Source precedence mirrors deck:upsert: docs/commander-decks/card-scripts.json
// (real names) first, then a fixture's stripped "<Name> Test" → "<Name>". Every
// script is validated before writing.
//
//   node --import tsx scripts/seed-scripts-local.mjs            → fill empty/null only
//   node --import tsx scripts/seed-scripts-local.mjs --force    → also overwrite differing
//
// HARD SAFETY: refuses to run unless the connection points at localhost/127.0.0.1
// (TEST_DATABASE_URL or the :54322 default), so it can NEVER touch hosted.

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Client } from 'pg'
import { validateCardScript } from '../lib/game/card-behavior-schema'

const LOCAL_DEFAULT = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const conn = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? LOCAL_DEFAULT
if (!/(localhost|127\.0\.0\.1)/.test(conn)) {
  console.error(`Refusing to run: connection "${conn}" is not local. This script is LOCAL-only.`)
  process.exit(1)
}

const force = process.argv.includes('--force')
const root = process.cwd()

// ── Build name → script (override wins, then fixture stripped, then fixture exact) ─
const byName = new Map() // lower(name) → script
function add(name, script) {
  if (!script || Object.keys(script).length === 0) return
  const key = name.toLowerCase()
  if (!byName.has(key)) byName.set(key, script)
}

// Basic lands need a mana-ability script too: both the client (selectFirstManaAbility)
// and the engine (activate_mana_ability via effective_script) read it — there is NO
// subtype synthesis. Hosted got these from an archived seed migration NOT applied to
// local, and import:cards leaves script empty, so local basics can't tap without this.
const BASIC_COLOR = {
  'Plains': 'W', 'Island': 'U', 'Swamp': 'B', 'Mountain': 'R', 'Forest': 'G', 'Wastes': 'C',
  'Snow-Covered Plains': 'W', 'Snow-Covered Island': 'U', 'Snow-Covered Swamp': 'B',
  'Snow-Covered Mountain': 'R', 'Snow-Covered Forest': 'G', 'Snow-Covered Wastes': 'C',
}
const basicManaScript = (color) => ({
  schema_version: 2,
  activated_abilities: [{ is_mana_ability: true, costs: [{ type: 'tap_self' }], effects: [{ type: 'add_mana', color, amount: 1 }] }],
})
for (const [name, color] of Object.entries(BASIC_COLOR)) add(name, basicManaScript(color))

const fixtures = JSON.parse(readFileSync(path.join(root, 'tests/fixtures/test-cards.json'), 'utf8'))
const overridesPath = path.join(root, 'docs/commander-decks/card-scripts.json')
if (existsSync(overridesPath)) {
  for (const [name, script] of Object.entries(JSON.parse(readFileSync(overridesPath, 'utf8')))) {
    if (!name.startsWith('_')) add(name, script)
  }
}
// Fixtures as fallback: a "Foo Test" fixture also fills the real "Foo".
for (const f of fixtures) {
  const n = f.name.toLowerCase()
  if (n.endsWith(' test')) add(n.slice(0, -5), f.script)
  add(f.name, f.script)
}

// Validate everything up front — never write an invalid script.
let invalid = 0
for (const [name, script] of byName) {
  const check = validateCardScript(script)
  if (!check.success) { console.error(`INVALID ${name}: ${check.errors.join('; ')}`); invalid++ }
}
if (invalid > 0) { console.error(`\n${invalid} invalid script(s) — aborting.`); process.exit(1) }

// ── Apply to the local catalog ────────────────────────────────────────────────
const c = new Client({ connectionString: conn })
await c.connect()
let filled = 0, overwritten = 0, keptDiffering = 0, notFound = 0
const stable = (v) => JSON.stringify(v)
try {
  for (const [name, script] of byName) {
    const rows = (await c.query('select id, script from public.cards where lower(name) = $1', [name])).rows
    if (rows.length === 0) { notFound++; continue }
    for (const row of rows) {
      const empty = !row.script || Object.keys(row.script).length === 0
      if (empty) {
        await c.query('update public.cards set script = $1::jsonb where id = $2', [stable(script), row.id])
        filled++
      } else if (stable(row.script) === stable(script)) {
        // already current
      } else if (force) {
        await c.query('update public.cards set script = $1::jsonb where id = $2', [stable(script), row.id])
        overwritten++
      } else {
        keptDiffering++
      }
    }
  }
} finally {
  await c.end()
}
console.log(`Local script seed: ${filled} filled, ${overwritten} overwritten, ${keptDiffering} kept (differs; --force to overwrite), ${notFound} name(s) not in local catalog.`)
