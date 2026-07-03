// Backfill co_card_tags by running the synergy tagger over every oracle card.
// Heuristic tags are static per oracle_id, so this runs offline (not per request).
//
//   node scripts/tag-backfill.mjs [--dry-run] [--limit N]
//
// Idempotent: clears existing source='heuristic' tags first, then re-tags. Manual /
// AI tags (other sources) are left untouched.

import { existsSync, readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

import { tagCard } from '../lib/collection/synergy/tagger.ts'

const PAGE = 1000
const INSERT_CHUNK = 1000

const options = parseArgs(process.argv.slice(2))
loadEnvFile('.env')
loadEnvFile('.env.local')
const dryRun = Boolean(options.dryRun)
const limit = options.limit === undefined ? null : Number(options.limit)

const supabase = createClient(
  getRequiredEnv('NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL'),
  getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_ROLE'),
  { auth: { persistSession: false, autoRefreshToken: false } },
)

if (!dryRun) {
  const { error } = await supabase.from('co_card_tags').delete().eq('source', 'heuristic')
  if (error) throw new Error(`Could not clear heuristic tags: ${error.message}`)
  console.log('Cleared existing heuristic tags.')
}

let processed = 0
let tagsWritten = 0
let buffer = []

for (let from = 0; ; from += PAGE) {
  const { data, error } = await supabase
    .from('co_card_oracle')
    .select('oracle_id, name, type_line, oracle_text, keywords, cmc')
    .order('oracle_id', { ascending: true })
    .range(from, from + PAGE - 1)

  if (error) throw new Error(`Read failed at offset ${from}: ${error.message}`)
  if (!data || data.length === 0) break

  for (const row of data) {
    const cardTags = tagCard({
      name: row.name,
      typeLine: row.type_line ?? '',
      oracleText: row.oracle_text,
      keywords: Array.isArray(row.keywords) ? row.keywords : [],
      cmc: Number(row.cmc) || 0,
    })
    for (const { tag, weight } of cardTags) {
      buffer.push({ oracle_id: row.oracle_id, tag, weight, source: 'heuristic' })
    }
    processed += 1
    if (limit !== null && processed >= limit) break
  }

  if (buffer.length >= INSERT_CHUNK) {
    tagsWritten += await flush(buffer)
    buffer = []
  }

  if ((limit !== null && processed >= limit) || data.length < PAGE) break
}

tagsWritten += await flush(buffer)

console.log(
  `${dryRun ? 'Dry run.' : 'Backfill complete.'} cards=${processed} tags=${tagsWritten}` +
    (limit !== null ? ` (limited to ${limit})` : ''),
)

async function flush(rows) {
  if (rows.length === 0) return 0
  if (dryRun) {
    console.log(`[dry-run] would write ${rows.length} tag rows, e.g.`, rows.slice(0, 3))
    return rows.length
  }
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK)
    const { error } = await supabase.from('co_card_tags').upsert(chunk, { onConflict: 'oracle_id,tag', ignoreDuplicates: false })
    if (error) throw new Error(`Tag upsert failed: ${error.message}`)
  }
  return rows.length
}

function parseArgs(args) {
  const parsed = {}
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--dry-run') { parsed.dryRun = true; continue }
    if (arg === '--limit') { parsed.limit = args[i + 1]; i += 1; continue }
    throw new Error(`Unknown argument: ${arg}`)
  }
  return parsed
}

function loadEnvFile(path) {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')
    if (!process.env[key]) process.env[key] = value
  }
}

function getRequiredEnv(...keys) {
  for (const key of keys) if (process.env[key]) return process.env[key]
  throw new Error(`Missing required environment variable. Tried: ${keys.join(', ')}`)
}
