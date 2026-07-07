// Seed shared PRECON decks onto the HOSTED card catalog so every player can pick
// them in the lobby (decks.is_precon = true, owner_id null). Reads the curated
// decklists in docs/commander-decks/*.txt, resolves each card by name against the
// catalog, and upserts a precon deck row — but ONLY for decks that are
// catalog-complete (every listed card resolves). Incomplete decks are reported
// and skipped.
//
//   npm run deck:seed-precons                 → DRY RUN of every decklist
//   npm run deck:seed-precons -- --apply      → write the precon rows
//   npm run deck:seed-precons -- krenko-goblins.txt --apply   → just one file
//
// Idempotent: re-running replaces the precon row of the same name. The service
// role bypasses RLS, so this writes the ownerless shared rows directly.
//
// Requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env(.local).

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const root = process.cwd()
const args = process.argv.slice(2)
const apply = args.includes('--apply')
const only = args.find((a) => !a.startsWith('--'))

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

const supabase = createClient(
  getRequiredEnv('NEXT_PUBLIC_SUPABASE_URL'),
  getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { persistSession: false } },
)

const decksDir = path.join(root, 'docs/commander-decks')
// Non-deck files in the folder: scaffolding + the in-progress working file.
const SKIP = new Set(['next-deck.txt'])
// Precon names must be unique (the dropdown + the idempotent replace key on it);
// two files sharing a commander get disambiguated by their pretty filename.
const usedNames = new Set()

/** Parse a decklist the way import_deck_from_text does (quantity, Commander header, set-code strip). */
function parseDecklist(text) {
  const lines = []
  let inCommander = false
  let commanderName = null
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const lower = line.toLowerCase()
    if (lower === 'commander') { inCommander = true; continue }
    if (lower === 'deck' || lower === 'sideboard') { inCommander = false; continue }
    line = line.replace(/^\s*SB:\s*/i, '')

    let quantity = 1
    let name = line
    const m = line.match(/^(\d+)x?\s+(.+)$/i)
    if (m) { quantity = Number.parseInt(m[1], 10); name = m[2].trim() }

    // Strip trailing set codes: " (SET) 123", " (SET)", " [..]".
    name = name.replace(/\s+\([^)]*\)\s+\d+\s*$/, '')
    name = name.replace(/\s+\([^)]*\)\s*$/, '')
    name = name.replace(/\s+\[[^\]]*\]\s*$/, '')
    name = name.trim()

    if (quantity <= 0 || name === '') continue
    if (inCommander && !commanderName) commanderName = name
    lines.push({ quantity, name })
  }
  return { lines, commanderName }
}

/** Resolve a card name to a catalog id (case-insensitive exact; prefers a printing
    with art). Falls back to the FRONT FACE of a double-faced name — decklists say
    "Bloodline Keeper", the catalog says "Bloodline Keeper // Lord of Lineage" —
    the same convention deck:triage/deck:upsert use. */
async function resolveCardId(name) {
  const exact = await bestMatch(name, (n) => n === name.toLowerCase())
  if (exact) return exact
  return bestMatch(`${name} // %`, (n) => n.startsWith(`${name.toLowerCase()} // `))
}

async function bestMatch(pattern, nameMatches) {
  const { data, error } = await supabase
    .from('cards')
    .select('id, name, image_url')
    .ilike('name', pattern)
  if (error) throw error
  const matches = (data ?? []).filter((c) => nameMatches((c.name ?? '').toLowerCase()))
  if (matches.length === 0) return null
  matches.sort((a, b) => (a.image_url ? 0 : 1) - (b.image_url ? 0 : 1) || a.id.localeCompare(b.id))
  return matches[0].id
}

function prettyName(file) {
  return file.replace(/\.txt$/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

async function seedFile(file) {
  const text = readFileSync(path.join(decksDir, file), 'utf8')
  const { lines, commanderName } = parseDecklist(text)
  if (lines.length === 0) return { file, skipped: 'no card lines' }

  // Resolve every unique name once.
  const idByName = new Map()
  const missing = []
  for (const name of new Set(lines.map((l) => l.name))) {
    const id = await resolveCardId(name)
    if (id) idByName.set(name.toLowerCase(), id)
    else missing.push(name)
  }
  if (missing.length > 0) {
    return { file, skipped: `${missing.length} card(s) not in catalog`, missing }
  }

  const listData = []
  for (const { quantity, name } of lines) {
    const id = idByName.get(name.toLowerCase())
    for (let i = 0; i < quantity; i++) listData.push(id)
  }
  const commanderId = commanderName ? idByName.get(commanderName.toLowerCase()) ?? null : null
  let deckName = commanderName ?? prettyName(file)
  if (usedNames.has(deckName.toLowerCase())) deckName = `${deckName} (${prettyName(file)})`
  usedNames.add(deckName.toLowerCase())

  const result = { file, deckName, card_count: listData.length, commander: commanderName, applied: false }
  if (!apply) return result

  // Idempotent replace: drop any existing precon of this name, then insert.
  const del = await supabase.from('decks').delete().eq('is_precon', true).eq('name', deckName)
  if (del.error) throw del.error
  const ins = await supabase.from('decks').insert({
    name: deckName,
    list_data: listData,
    commander_card_id: commanderId,
    owner_id: null,
    created_by: null,
    is_precon: true,
  })
  if (ins.error) throw ins.error
  result.applied = true
  return result
}

const files = (only ? [only] : readdirSync(decksDir))
  .filter((f) => f.toLowerCase().endsWith('.txt') && !SKIP.has(f))

if (files.length === 0) {
  console.error('No decklist .txt files found.')
  process.exit(1)
}

console.log(`${apply ? 'APPLYING' : 'DRY RUN'} — ${files.length} decklist(s)\n`)
const seeded = []
const skipped = []
for (const file of files) {
  try {
    const r = await seedFile(file)
    if (r.skipped) {
      skipped.push(r)
      console.log(`  SKIP  ${file} — ${r.skipped}${r.missing ? `: ${r.missing.slice(0, 6).join(', ')}${r.missing.length > 6 ? ', …' : ''}` : ''}`)
    } else {
      seeded.push(r)
      console.log(`  ${r.applied ? 'WROTE' : 'OK   '} ${r.deckName} (${r.card_count} cards${r.commander ? `, commander: ${r.commander}` : ''})`)
    }
  } catch (error) {
    console.error(`  ERROR ${file}:`, error.message ?? error)
    process.exitCode = 1
  }
}

console.log(`\n${seeded.length} catalog-complete, ${skipped.length} skipped.`)
if (!apply) console.log('Re-run with --apply to write the precon rows.')
