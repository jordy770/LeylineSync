// Decklist triage — the planning step before implementing a deck's cards.
//
//   npm run deck:triage                       → docs/commander-decks/next-deck.txt
//   npm run deck:triage -- path/to/deck.txt   → any decklist file
//
// For every card in the list, look up the GROUND-TRUTH oracle text in the
// Scryfall dump (lib/oracle-cards-*.json — never plan from remembered card
// text; cerebrum rule) and bucket it:
//
//   IMPLEMENTED  — a "<Name> Test" fixture exists in tests/fixtures/test-cards.json
//                  (engine-tested in this project)
//   WORKS AS-IS  — no rules text, a basic land, or only engine-supported
//                  keyword lines (registered automatically from cards.keywords)
//   NEEDS BUILD  — has rules text and no fixture; listed with full oracle text,
//                  ready to hand to a planning session
//   NOT FOUND    — name not in the oracle dump (typo, or dump out of date)
//
// Writes <decklist>.triage.md next to the input and prints a summary.
// Advisory only: a NEEDS BUILD card may already work as a free composition —
// the report is the to-triage list, not a verdict.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
// Requires `node --import tsx` (the deck:triage npm script does this).
import { validateCardScript } from '../lib/game/card-behavior-schema'

const root = process.cwd()
const input = path.resolve(root, process.argv[2] ?? 'docs/commander-decks/next-deck.txt')

// Keywords the engine registers automatically (BUILDER_KEYWORDS + the combat
// set wired through register_card_continuous_effects). A card whose oracle text
// is ONLY these (comma-separated keyword lines) works without authoring.
const SUPPORTED_KEYWORDS = new Set([
  'flying', 'reach', 'haste', 'vigilance', 'trample', 'indestructible',
  'first strike', 'double strike', 'deathtouch', 'menace', 'intimidate',
  'hexproof', 'infect', 'wither',
])

// ── Parse the decklist ────────────────────────────────────────────────────────
// Same contract as the in-app importer (import_deck_from_text): ONLY lines that
// start with a count ("1 Card Name" / "2x Card Name") are cards; every other
// non-comment line is a section header ("Commander", "Instants & Sorceries", …).
const lines = readFileSync(input, 'utf8').split('\n')
const cards = []
let inCommander = false
for (const rawLine of lines) {
  const line = rawLine.trim()
  if (line === '' || line.startsWith('#') || line.startsWith('//')) continue
  const m = line.match(/^(\d+)x?\s+(.+)$/)
  if (!m) {
    inCommander = line.toLowerCase() === 'commander'
    continue
  }
  const name = m[2].trim()
  if (name === '') continue
  cards.push({ name, count: Number(m[1]), commander: inCommander })
}

if (cards.length === 0) {
  console.error(`No cards found in ${path.relative(root, input)} — paste the decklist first.`)
  process.exit(1)
}

// ── Load oracle ground truth + the implemented-fixture set ──────────────────
const libDir = path.join(root, 'lib')
const oracleFile = readdirSync(libDir).filter((f) => /^oracle-cards-.*\.json$/.test(f)).sort().pop()
if (!oracleFile) {
  console.error('No lib/oracle-cards-*.json found — download the Scryfall "Oracle Cards" bulk file (see .gitignore note).')
  process.exit(1)
}
console.log(`Oracle dump: lib/${oracleFile} (loading...)`)
const oracle = new Map()
// Multi-face cards (DFC / omen / split) keep their text in card_faces, not the
// top-level fields — flatten it so classification sees the real rules text.
const flatten = (c) => {
  if (!Array.isArray(c.card_faces) || c.card_faces.length === 0) return c
  return {
    name: c.name,
    type_line: c.type_line && c.type_line !== 'Card // Card'
      ? c.type_line
      : c.card_faces.map((f) => f.type_line).filter(Boolean).join(' // '),
    oracle_text: c.card_faces.map((f) => f.oracle_text).filter(Boolean).join('\n//\n'),
  }
}
const dump = JSON.parse(readFileSync(path.join(libDir, oracleFile), 'utf8'))
// Pass 1: exact full names ALWAYS win (so basic Mountain never loses to a
// DFC whose front face is named "Mountain ...").
for (const c of dump) {
  const key = c.name.toLowerCase()
  if (!oracle.has(key)) oracle.set(key, flatten(c))
}
// Pass 2: front-face names as fallbacks only.
for (const c of dump) {
  const front = c.name.split(' // ')[0].toLowerCase()
  if (!oracle.has(front)) oracle.set(front, flatten(c))
}

const fixtures = JSON.parse(readFileSync(path.join(root, 'tests/fixtures/test-cards.json'), 'utf8'))
const fixtureNames = new Set()
const fixtureScripts = new Map() // lowercase real-card name → engine-verified script
for (const f of fixtures) {
  const n = f.name.toLowerCase()
  fixtureNames.add(n)
  const hasScript = f.script && Object.keys(f.script).length > 0
  if (hasScript) fixtureScripts.set(n, f.script)
  if (n.endsWith(' test')) {
    fixtureNames.add(n.slice(0, -5))
    if (hasScript) fixtureScripts.set(n.slice(0, -5), f.script)
  }
}

// Curated real-card scripts (cards whose fixture lives under another name, or
// trivial shapes with no fixture). Merged OVER fixture-derived scripts.
const overridesPath = path.join(root, 'docs/commander-decks/card-scripts.json')
const scriptOverrides = new Map()
if (existsSync(overridesPath)) {
  for (const [name, script] of Object.entries(JSON.parse(readFileSync(overridesPath, 'utf8')))) {
    if (!name.startsWith('_')) scriptOverrides.set(name.toLowerCase(), script)
  }
}

// Real cards covered by a fixture under a DIFFERENT name, or by tested engine
// primitives that need no fixture (free re-skins of proven shapes). Keyed
// lowercase. Keep this honest: only list cards whose every line is engine-
// covered; authoring still happens in the behavior editor.
const COVERED_BY = new Map(Object.entries({
  'champion of the perished': 'Champion Watcher Test (creature_entered watcher + counter)',
  'eternal skylord': 'Skylord Test (token-only flying grant) + amass tests (mig 182/200)',
  'gray merchant of asphodel': 'Gray Merchant Test (devotion drain)',
  'josu vess, lich knight': 'Josu Vess Test (kicker, mig 211)',
  'crippling fear': 'crippling-fear.test.ts (choose type + mass debuff, mig 179)',
  'vizier of the scorpion': 'amass ETB + token-only deathtouch grant (Gleaming Overseer shape, mig 200)',
  'sol ring': 'plain mana ability ({T}: add {C}{C}) — engine-native',
  'arcane signet': "commander-identity mana (mig 151, the card the feature was built for)",
  'command tower': 'commander-identity mana (mig 151)',
  'pilfered plans': 'choose_player→mill + draw composition (both halves tested)',
  'salt marsh': 'Salt Marsh Test (enters_tapped, mig 217)',
  'submerged boneyard': 'Salt Marsh Test shape (plain enters_tapped dual, mig 217)',
  'dismal backwater': 'Jwar Isle Refuge Test shape (enters_tapped + ETB gain 1, mig 217)',
  'jwar isle refuge': 'Jwar Isle Refuge Test (mig 217)',
  'temple of deceit': 'enters_tapped + ETB scry 1 (both tested, mig 217)',
  'sunken hollow': 'Sunken Hollow Test (basic-land condition, mig 217)',
  'choked estuary': 'Choked Estuary Test (hand_has_type condition, mig 217)',
  'ureni of the unwritten': 'Ureni Test (look_top dig-8, mig 223)',
  'migration path': 'Migration Path Test (search 2 basics tapped, mig 217/111)',
  'evolving wilds': 'Evolving Wilds Test (sac-tutor basic, mig 187)',
  'verix bladewing': 'Verix Bladewing Test (kicker, mig 211)',
  'keiga, the tide star': 'Keiga Test (dies-gain-control, mig 106)',
  'lathliss, dragon queen': 'Lathliss Test (Dragon-enters watcher token; activated pump deferred)',
  'dragonmaster outcast': 'Dragonmaster Outcast Test (conditional 6 lands → Dragon)',
  "dragon's hoard": "Dragon's Hoard Test (gold counters + draw + any mana)",
  'rapid hybridization': 'Rapid Hybridization Test (destroy + Frog Lizard)',
  'blasphemous act': 'Blasphemous Act Test (deal_damage_all, mig 224)',
  "storm's wrath": "Storm's Wrath Test (mass damage + planeswalkers, mig 224)",
  'harbinger of the hunt': 'Harbinger of the Hunt Test (flying-filtered mass damage, mig 224)',
  'rapacious dragon': 'Rapacious Dragon Test (ETB two Treasures, mig 226)',
  'atarka, world render': 'Atarka World Render Test (reflexive attack watcher, mig 227)',
  'dragon tempest': 'Dragon Tempest Test (flying-enter haste; the damage half is deferred)',
  'sheltered thicket': 'card-scripts.json (tapland + cycling, mig 228)',
  'bountiful landscape': 'card-scripts.json (mana + sac-tutor + cycling, mig 228)',
}))

// ── Classify ─────────────────────────────────────────────────────────────────
function isKeywordsOnly(text) {
  const meaningful = text.split('\n').map((l) => l.replace(/\(.*?\)/g, '').trim()).filter(Boolean)
  if (meaningful.length === 0) return true
  return meaningful.every((l) =>
    l.split(',').every((kw) => SUPPORTED_KEYWORDS.has(kw.trim().toLowerCase().replace(/\.$/, ''))),
  )
}

const buckets = { implemented: [], works: [], build: [], missing: [] }
for (const card of cards) {
  const entry = oracle.get(card.name.toLowerCase())
  if (!entry) {
    buckets.missing.push({ card })
    continue
  }
  const enriched = { card, type: entry.type_line ?? '', text: (entry.oracle_text ?? '').trim() }
  const key = card.name.toLowerCase()
  const covered = COVERED_BY.get(key)
  if (fixtureNames.has(key)) {
    buckets.implemented.push(enriched)
  } else if (covered) {
    buckets.implemented.push({ ...enriched, via: covered })
  } else if (scriptOverrides.has(key)) {
    // A curated script exists (card-scripts.json) — covered, no fixture needed.
    buckets.implemented.push({ ...enriched, via: 'card-scripts.json (curated)' })
  } else if (/^basic land/i.test(enriched.type) || enriched.text === '' || isKeywordsOnly(enriched.text)) {
    buckets.works.push(enriched)
  } else {
    buckets.build.push(enriched)
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
const rel = path.relative(root, input)
const out = []
out.push(`# Deck triage — ${rel}`)
out.push('')
out.push(`${cards.length} cards: **${buckets.implemented.length} implemented**, **${buckets.works.length} work as-is**, **${buckets.build.length} need building**, **${buckets.missing.length} not in the oracle dump**.`)
out.push('')
if (buckets.missing.length) {
  out.push('## ⚠️ Not found in the oracle dump (typo, or dump out of date)')
  out.push('')
  for (const { card } of buckets.missing) out.push(`- ${card.name}`)
  out.push('')
}
if (buckets.build.length) {
  out.push('## ❓ Needs building (oracle text included — plan from THIS, never from memory)')
  out.push('')
  for (const { card, type, text } of buckets.build) {
    out.push(`### ${card.name}${card.commander ? ' (COMMANDER)' : ''}`)
    out.push(`*${type}*`)
    out.push('')
    out.push(text.split('\n').map((l) => `> ${l}`).join('\n'))
    out.push('')
  }
}
if (buckets.works.length) {
  out.push('## 🟢 Works as-is (no rules text / supported keywords only)')
  out.push('')
  for (const { card, type } of buckets.works) out.push(`- ${card.name} — *${type}*`)
  out.push('')
}
if (buckets.implemented.length) {
  out.push('## ✅ Already implemented (engine-covered; author the script in the behavior editor)')
  out.push('')
  for (const { card, via } of buckets.implemented) out.push(`- ${card.name}${via ? ` — covered by ${via}` : ''}`)
  out.push('')
}

// ── Copy-paste scripts ───────────────────────────────────────────────────────
// For every card we can resolve a script for (the override file first, then an
// engine-verified fixture), emit a fenced JSON block — paste straight into the
// behavior editor's JSON mode. Every script is validated before it is written.
const emitted = new Set()
const scriptSections = []
const invalidScripts = []
const tokenDeps = new Set()
for (const card of cards) {
  const key = card.name.toLowerCase()
  if (emitted.has(key)) continue
  emitted.add(key)
  const script = scriptOverrides.get(key) ?? fixtureScripts.get(key)
  if (!script) continue
  const check = validateCardScript(script)
  if (!check.success) {
    invalidScripts.push(card.name + ': ' + check.errors.join('; '))
    continue
  }
  const json = JSON.stringify(script)
  for (const m of json.matchAll(/"token":\s*"([^"]+)"/g)) tokenDeps.add(m[1])
  // amass finds-or-creates the seeded 'Zombie Army' token by name (mig 182).
  if (json.includes('"amass"')) tokenDeps.add('Zombie Army')
  scriptSections.push('### ' + card.name, '', '```json', JSON.stringify(script, null, 2), '```', '')
}
if (invalidScripts.length > 0) {
  console.error('INVALID scripts skipped:')
  for (const line of invalidScripts) console.error('  - ' + line)
  process.exitCode = 1
}
if (scriptSections.length > 0) {
  out.push('## 📋 Scripts — paste into the behavior editor (JSON mode)')
  out.push('')
  out.push('Engine-verified: fixture scripts for the tested cards, curated entries (docs/commander-decks/card-scripts.json) for the rest. Cards not listed need no script (basic lands, vanilla keywords).')
  if (tokenDeps.size > 0) {
    out.push('')
    out.push('**Token catalog dependency:** these scripts create tokens by name — your card catalog needs is_token rows named: ' + [...tokenDeps].sort().join(', ') + '.')
  }
  out.push('')
  out.push(...scriptSections)
}

const reportPath = input.replace(/\.txt$/, '') + '.triage.md'
writeFileSync(reportPath, out.join('\n'))
console.log(`\n${cards.length} cards — implemented: ${buckets.implemented.length}, works as-is: ${buckets.works.length}, NEEDS BUILD: ${buckets.build.length}, not found: ${buckets.missing.length}`)
console.log(`Report: ${path.relative(root, reportPath)}`)
