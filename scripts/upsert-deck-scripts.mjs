// Upsert a decklist's behavior scripts onto the HOSTED card catalog
// (public.cards.script) — the batch version of pasting each script into the
// behavior editor's JSON mode.
//
//   npm run deck:upsert                          → DRY RUN of next-deck.txt
//   npm run deck:upsert -- --apply               → write the changes
//   npm run deck:upsert -- path/to/deck.txt --apply
//   --force        also overwrite cards whose existing script DIFFERS
//   --no-tokens    skip creating missing token catalog rows
//
// Script resolution mirrors deck:triage: docs/commander-decks/card-scripts.json
// first, then the engine-verified fixture ("<Name> Test" or exact name) from
// tests/fixtures/test-cards.json. Every script is validated with
// validateCardScript before anything is written. Updates hit EVERY printing of
// the name (the deck importer matches by name; extra printings are harmless and
// reimports never touch cards.script).
//
// Safety defaults: dry run unless --apply; an existing DIFFERENT script is
// never overwritten without --force (your hand-authored edits win). Missing
// token rows (Zombie Token, …) are created from their fixture stats so
// create_token/amass resolve in real games.
//
// Requires `node --import tsx` (the npm script does this) and the same env as
// import:cards: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env(.local).

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { validateCardScript } from '../lib/game/card-behavior-schema'

const root = process.cwd()
const args = process.argv.slice(2)
const apply = args.includes('--apply')
const force = args.includes('--force')
const createTokens = !args.includes('--no-tokens')
const inputArg = args.find((a) => !a.startsWith('--'))
const input = path.resolve(root, inputArg ?? 'docs/commander-decks/next-deck.txt')

function loadEnvFile(p) {
  if (!existsSync(p)) return
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const i = trimmed.indexOf('=')
    if (i < 0) continue
    const key = trimmed.slice(0, i).trim()
    if (!process.env[key]) process.env[key] = trimmed.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')
  }
}
loadEnvFile('.env')
loadEnvFile('.env.local')

function getRequiredEnv(...keys) {
  for (const key of keys) if (process.env[key]) return process.env[key]
  throw new Error(`Missing required environment variable. Tried: ${keys.join(', ')}`)
}

// ── Parse the decklist (importer contract: only "N Card Name" lines are cards) ─
const cardNames = []
const seen = new Set()
for (const raw of readFileSync(input, 'utf8').split('\n')) {
  const line = raw.trim()
  if (line === '' || line.startsWith('#') || line.startsWith('//')) continue
  const m = line.match(/^(\d+)x?\s+(.+)$/)
  if (!m) continue
  const name = m[2].trim()
  if (name && !seen.has(name.toLowerCase())) {
    seen.add(name.toLowerCase())
    cardNames.push(name)
  }
}
if (cardNames.length === 0) {
  console.error(`No cards found in ${path.relative(root, input)}.`)
  process.exit(1)
}

// ── Resolve scripts (same precedence as deck:triage) ─────────────────────────
const fixtures = JSON.parse(readFileSync(path.join(root, 'tests/fixtures/test-cards.json'), 'utf8'))
const fixtureScripts = new Map()
const fixtureRows = new Map() // for token creation stats
for (const f of fixtures) {
  const n = f.name.toLowerCase()
  fixtureRows.set(n, f)
  const hasScript = f.script && Object.keys(f.script).length > 0
  if (hasScript) fixtureScripts.set(n, f.script)
  if (n.endsWith(' test') && hasScript) fixtureScripts.set(n.slice(0, -5), f.script)
}
const scriptOverrides = new Map()
const overridesPath = path.join(root, 'docs/commander-decks/card-scripts.json')
if (existsSync(overridesPath)) {
  for (const [name, script] of Object.entries(JSON.parse(readFileSync(overridesPath, 'utf8')))) {
    if (!name.startsWith('_')) scriptOverrides.set(name.toLowerCase(), script)
  }
}

const plan = []
const tokenDeps = new Set()
let invalid = 0
for (const name of cardNames) {
  const key = name.toLowerCase()
  // Adventure/DFC scripts are keyed by the FRONT face name; the decklist (and
  // the catalog rows) use the full "Front // Back" name.
  const keys = key.includes(' // ') ? [key, key.split(' // ')[0]] : [key]
  const script =
    keys.map((k) => scriptOverrides.get(k)).find(Boolean) ??
    keys.map((k) => fixtureScripts.get(k)).find(Boolean)
  if (!script) continue // no script needed / nothing to push
  const check = validateCardScript(script)
  if (!check.success) {
    console.error(`INVALID script for ${name}: ${check.errors.join('; ')}`)
    invalid++
    continue
  }
  const json = JSON.stringify(script)
  for (const m of json.matchAll(/"token":\s*"([^"]+)"/g)) tokenDeps.add(m[1])
  if (json.includes('"amass"')) tokenDeps.add('Zombie Army')
  plan.push({ name, script })
}
if (invalid > 0) process.exit(1)

// ── Hosted catalog ────────────────────────────────────────────────────────────
const supabase = createClient(
  getRequiredEnv('NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL'),
  getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_ROLE'),
  { auth: { persistSession: false, autoRefreshToken: false } },
)

// Canonical JSON for order-independent comparison: recursively sort object keys
// (arrays keep their order — element order is significant in scripts). NOTE: the
// previous one-liner `JSON.stringify(v, Object.keys(v).sort())` passed an ARRAY
// as the replacer, which JSON.stringify treats as a property ALLOWLIST applied at
// every nesting level — so it dropped all nested fields and reported any two
// scripts with the same top-level keys as identical, silently refusing to push
// nested edits (e.g. a new target_filter).
const canonicalize = (v) =>
  Array.isArray(v)
    ? v.map(canonicalize)
    : v && typeof v === 'object'
      ? Object.keys(v).sort().reduce((acc, k) => { acc[k] = canonicalize(v[k]); return acc }, {})
      : v
const stable = (v) => JSON.stringify(canonicalize(v))
let updated = 0, current = 0, skippedDiffering = 0, notFound = 0, written = 0

for (const { name, script } of plan) {
  const esc = name.replaceAll('%', '\\%').replaceAll('_', '\\_')
  let { data: rows, error } = await supabase
    .from('cards')
    .select('id, name, script')
    .ilike('name', esc)
  if (error) throw new Error(`select ${name}: ${error.message}`)
  // A front-face-only decklist name ("Bloodline Keeper") matches its DFC catalog
  // row ("Bloodline Keeper // Lord of Lineage") by prefix — mirrors seed-precons.
  if ((!rows || rows.length === 0) && !name.includes(' // ')) {
    const dfc = await supabase.from('cards').select('id, name, script').ilike('name', `${esc} // %`)
    if (dfc.error) throw new Error(`select ${name}: ${dfc.error.message}`)
    rows = dfc.data
  }
  if (!rows || rows.length === 0) {
    console.log(`NOT IN CATALOG  ${name} (run npm run import:cards, or check the name)`)
    notFound++
    continue
  }
  const targets = []
  for (const row of rows) {
    const existing = row.script && Object.keys(row.script).length > 0 ? row.script : null
    if (existing && stable(existing) === stable(script)) { current++; continue }
    if (existing && !force) {
      console.log(`DIFFERS (kept)  ${name} [${row.id}] — existing script differs; use --force to overwrite`)
      skippedDiffering++
      continue
    }
    targets.push(row.id)
  }
  if (targets.length === 0) continue
  if (apply) {
    const { error: upErr } = await supabase.from('cards').update({ script }).in('id', targets)
    if (upErr) throw new Error(`update ${name}: ${upErr.message}`)
    written += targets.length
  }
  console.log(`${apply ? 'UPDATED' : 'WOULD UPDATE'}  ${name} (${targets.length} printing${targets.length > 1 ? 's' : ''})`)
  updated++
}

// ── Token catalog rows ────────────────────────────────────────────────────────
if (createTokens && tokenDeps.size > 0) {
  for (const tokenName of [...tokenDeps].sort()) {
    const { data: rows, error } = await supabase
      .from('cards').select('id').eq('is_token', true).ilike('name', tokenName)
    if (error) throw new Error(`select token ${tokenName}: ${error.message}`)
    if (rows && rows.length > 0) continue
    const fx = fixtureRows.get(tokenName.toLowerCase())
    if (!fx) {
      console.log(`TOKEN MISSING   ${tokenName} — no fixture stats to create it from; add it manually`)
      continue
    }
    if (apply) {
      const { error: insErr } = await supabase.from('cards').insert({
        id: randomUUID(),
        name: fx.name,
        type_line: fx.type_line,
        oracle_text: fx.oracle_text,
        power_toughness: fx.power_toughness,
        mana_cost: fx.mana_cost ?? null,
        is_token: true,
        script: fx.script ?? {},
      })
      if (insErr) throw new Error(`insert token ${tokenName}: ${insErr.message}`)
    }
    console.log(`${apply ? 'TOKEN CREATED' : 'WOULD CREATE TOKEN'}  ${tokenName}`)
  }
}

console.log(`\n${apply ? 'APPLIED' : 'DRY RUN (use --apply to write)'} — ` +
  `${updated} card(s) ${apply ? 'updated' : 'to update'}${apply ? ` (${written} printings)` : ''}, ` +
  `${current} already current, ${skippedDiffering} kept (differs), ${notFound} not in catalog.`)
