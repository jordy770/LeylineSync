// Import Scryfall bulk card data into public.co_card_printings (Collection Optimizer).
//
// Separate from import-scryfall-cards.mjs (the game `cards` catalog) on purpose:
//   * different target table + columns (colors, color_identity, cmc, prices, sets, finishes)
//   * different upsert semantics — DO UPDATE on scryfall_id so re-imports REFRESH prices,
//     and NO canonical dedup so every printing is kept (needed to match ManaBox Set+Collector#).
//
// MVP input: oracle-cards bulk (lib/oracle-cards.json — one representative printing per
// card; gets colors/cmc/prices/set onto every card cheaply). Point --file at a
// default-cards bulk later to fill EVERY printing into the same table.
//
//   node scripts/import-card-printings.mjs [--file <bulk.json>] [--limit N]
//                                          [--batch-size N] [--dry-run]
//                                          [--include-digital] [--include-extras]

import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const defaultInputFile = 'lib/oracle-cards.json'
const defaultBatchSize = 500
const maxAttempts = 4

const options = parseArgs(process.argv.slice(2))
loadEnvFile('.env')
loadEnvFile('.env.local')

const inputFile = resolve(options.file ?? defaultInputFile)
const batchSize = Number(options.batchSize ?? defaultBatchSize)
const limit = options.limit === undefined ? null : Number(options.limit)
const dryRun = Boolean(options.dryRun)
const includeDigital = Boolean(options.includeDigital)
const includeExtras = Boolean(options.includeExtras)

if (!existsSync(inputFile)) {
  throw new Error(`Input file not found: ${inputFile}`)
}
if (!Number.isInteger(batchSize) || batchSize <= 0) {
  throw new Error(`Invalid --batch-size value: ${String(options.batchSize)}`)
}
if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
  throw new Error(`Invalid --limit value: ${String(options.limit)}`)
}

const supabase = dryRun
  ? null
  : createClient(
      getRequiredEnv('NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL'),
      getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_ROLE'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    )

const syncedAt = new Date().toISOString()
let readCount = 0
let skippedCount = 0
let preparedCount = 0
let importedCount = 0
let batch = []

for await (const card of readJsonObjects(inputFile)) {
  readCount += 1

  if (getSkipReason(card)) {
    skippedCount += 1
    continue
  }

  const row = mapScryfallCardToRow(card)
  if (!row) {
    skippedCount += 1
    continue
  }

  batch.push(row)
  preparedCount += 1

  if (batch.length >= batchSize) {
    await flushBatch()
  }
  if (limit !== null && preparedCount >= limit) {
    break
  }
}

await flushBatch()

console.log(
  [
    dryRun ? 'Dry run complete.' : 'Import complete.',
    `read=${readCount}`,
    `prepared=${preparedCount}`,
    `imported=${importedCount}`,
    `skipped=${skippedCount}`,
    `file=${inputFile}`,
  ].join(' '),
)

async function flushBatch() {
  if (batch.length === 0) return

  const currentBatch = batch
  batch = []

  if (dryRun) {
    importedCount += currentBatch.length
    console.log(`[dry-run] prepared ${currentBatch.length} printings, latest: ${currentBatch.at(-1)?.name}`)
    return
  }

  await upsertBatchWithRetry(currentBatch)
  importedCount += currentBatch.length
  console.log(`Imported ${importedCount} printings, latest: ${currentBatch.at(-1)?.name}`)
}

async function upsertBatchWithRetry(currentBatch) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // DO UPDATE on scryfall_id: re-imports refresh prices and card data in place.
    const { error } = await supabase
      .from('co_card_printings')
      .upsert(currentBatch, { onConflict: 'scryfall_id', ignoreDuplicates: false })

    if (!error) return

    const message = getSupabaseErrorMessage(error)
    if (attempt === maxAttempts) {
      throw new Error(
        [
          `Failed to upsert ${currentBatch.length} printings after ${maxAttempts} attempts.`,
          `Latest: ${currentBatch.at(-1)?.name ?? 'unknown'}.`,
          message,
          'Try a smaller batch: npm run import:printings -- --batch-size 100',
        ].join(' '),
      )
    }

    const delayMs = 750 * attempt
    console.warn(`Upsert failed (${currentBatch.length}), attempt ${attempt}/${maxAttempts}. Retrying in ${delayMs}ms. ${message}`)
    await wait(delayMs)
  }
}

function getSkipReason(card) {
  if (!card || card.object !== 'card') return 'invalid'
  if (!card.id || !card.oracle_id || !card.name) return 'invalid'
  // Paper-collection mirror: drop Arena-only / Alchemy cards.
  if (!includeDigital && card.digital === true && isDigitalOnlyCard(card)) return 'digital'
  // Tokens/emblems/schemes can't sit in a 99 — skip unless explicitly wanted.
  if (!includeExtras && isExtraCardObject(card)) return 'extra'
  return null
}

function isDigitalOnlyCard(card) {
  return card.set_type === 'alchemy' || /^A-/.test(String(card.name ?? ''))
}

function isExtraCardObject(card) {
  const layout = String(card.layout ?? '').toLowerCase()
  const typeLine = String(card.type_line ?? '').toLowerCase()
  if (['token', 'double_faced_token', 'emblem', 'planar', 'scheme', 'vanguard', 'art_series'].includes(layout)) {
    return true
  }
  return (
    typeLine === 'card' ||
    typeLine.includes('token') ||
    typeLine.includes('emblem') ||
    /\bplane\b/.test(typeLine) ||
    typeLine.includes('phenomenon') ||
    typeLine.includes('scheme') ||
    typeLine.includes('vanguard') ||
    typeLine.includes('dungeon') ||
    typeLine.includes('sticker')
  )
}

function mapScryfallCardToRow(card) {
  return removeUndefinedValues({
    scryfall_id: card.id,
    oracle_id: card.oracle_id,
    name: card.name,
    set_code: card.set ?? null,
    collector_num: card.collector_number ?? null,
    colors: getColors(card),
    color_identity: Array.isArray(card.color_identity) ? card.color_identity : [],
    mana_cost: getManaCost(card),
    cmc: typeof card.cmc === 'number' ? card.cmc : 0,
    type_line: getTypeLine(card),
    oracle_text: getOracleText(card),
    keywords: Array.isArray(card.keywords) ? card.keywords : [],
    rarity: card.rarity ?? null,
    layout: card.layout ?? null,
    finishes: Array.isArray(card.finishes) ? card.finishes : [],
    image_uris: getImageUris(card),
    prices: card.prices ?? null,
    prices_synced_at: syncedAt,
  })
}

function getColors(card) {
  if (Array.isArray(card.colors)) return card.colors
  // MDFC/transform: colors live on the faces — union them.
  const faceColors = card.card_faces?.flatMap((face) => (Array.isArray(face.colors) ? face.colors : [])) ?? []
  return [...new Set(faceColors)]
}

function getImageUris(card) {
  return card.image_uris ?? card.card_faces?.[0]?.image_uris ?? null
}

function getManaCost(card) {
  // Joined two-faced cost ("{4}{R} // {1}{R}") → keep only the front castable face.
  if (card.mana_cost && !card.mana_cost.includes('//')) return card.mana_cost
  const frontFaceCost = card.card_faces?.find((face) => face.mana_cost)?.mana_cost
  return frontFaceCost || card.mana_cost || null
}

function getTypeLine(card) {
  return card.type_line || card.card_faces?.map((face) => face.type_line).filter(Boolean).join(' // ') || null
}

function getOracleText(card) {
  if (card.oracle_text) return card.oracle_text
  const faceTexts = card.card_faces?.map((face) => [face.name, face.oracle_text].filter(Boolean).join('\n')).filter(Boolean)
  return faceTexts?.length ? faceTexts.join('\n\n//\n\n') : null
}

function removeUndefinedValues(row) {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined))
}

function getSupabaseErrorMessage(error) {
  return [
    error.message ? `message=${error.message}` : null,
    error.code ? `code=${error.code}` : null,
    error.details ? `details=${error.details}` : null,
    error.hint ? `hint=${error.hint}` : null,
  ]
    .filter(Boolean)
    .join(' ')
}

function wait(delayMs) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs))
}

function parseArgs(args) {
  const parsed = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--dry-run') { parsed.dryRun = true; continue }
    if (arg === '--include-digital') { parsed.includeDigital = true; continue }
    if (arg === '--include-extras') { parsed.includeExtras = true; continue }
    if (arg === '--file' || arg === '--limit' || arg === '--batch-size') {
      parsed[toCamelCase(arg.slice(2))] = args[index + 1]
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }
  return parsed
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
}

function loadEnvFile(path) {
  if (!existsSync(path)) return
  const envFile = readFileSync(path, 'utf8')
  for (const line of envFile.split(/\r?\n/)) {
    const trimmedLine = line.trim()
    if (!trimmedLine || trimmedLine.startsWith('#')) continue
    const separatorIndex = trimmedLine.indexOf('=')
    if (separatorIndex < 0) continue
    const key = trimmedLine.slice(0, separatorIndex).trim()
    const value = trimmedLine.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, '')
    if (!process.env[key]) process.env[key] = value
  }
}

function getRequiredEnv(...keys) {
  for (const key of keys) {
    if (process.env[key]) return process.env[key]
  }
  throw new Error(`Missing required environment variable. Tried: ${keys.join(', ')}`)
}

async function* readJsonObjects(path) {
  const stream = createReadStream(path, { encoding: 'utf8' })
  let buffer = ''
  let depth = 0
  let isInString = false
  let isEscaped = false
  let isCapturing = false

  for await (const chunk of stream) {
    for (const char of chunk) {
      if (!isCapturing) {
        if (char === '{') {
          isCapturing = true
          depth = 1
          buffer = char
        }
        continue
      }

      buffer += char

      if (isEscaped) { isEscaped = false; continue }
      if (char === '\\' && isInString) { isEscaped = true; continue }
      if (char === '"') { isInString = !isInString; continue }
      if (isInString) continue

      if (char === '{') depth += 1
      else if (char === '}') depth -= 1

      if (depth === 0) {
        yield JSON.parse(buffer)
        buffer = ''
        isCapturing = false
        isInString = false
        isEscaped = false
      }
    }
  }

  if (isCapturing || buffer.trim()) {
    throw new Error('Input JSON ended while a card object was still open')
  }
}
