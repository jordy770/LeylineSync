import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const defaultInputFile = 'lib/oracle-cards-20260531210653.json'
const defaultBatchSize = 100
const maxAttempts = 4

const options = parseArgs(process.argv.slice(2))
loadEnvFile('.env')
loadEnvFile('.env.local')

const inputFile = resolve(options.file ?? defaultInputFile)
const batchSize = Number(options.batchSize ?? defaultBatchSize)
const limit = options.limit === undefined ? null : Number(options.limit)
const dryRun = Boolean(options.dryRun)
const includeDigital = Boolean(options.includeDigital)
const includeNonEnglish = Boolean(options.includeNonEnglish)
const canonicalOnly = !options.allPrints
const playableOnly = !options.includeExtras

if (!existsSync(inputFile)) {
  throw new Error(`Input file not found: ${inputFile}`)
}

if (!Number.isInteger(batchSize) || batchSize <= 0) {
  throw new Error(`Invalid --batch-size value: ${String(options.batchSize)}`)
}

if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
  throw new Error(`Invalid --limit value: ${String(options.limit)}`)
}

const supabase =
  dryRun
    ? null
    : createClient(
        getRequiredEnv('NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL'),
        getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_ROLE'),
        {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
          },
        },
      )

let readCount = 0
let skippedCount = 0
let skippedDuplicateCount = 0
let skippedExtraCount = 0
let preparedCount = 0
let importedCount = 0
let batch = []
const seenOracleIds = new Set()

for await (const card of readJsonObjects(inputFile)) {
  readCount += 1

  const skipReason = getSkipReason(card)

  if (skipReason) {
    skippedCount += 1
    if (skipReason === 'extra') {
      skippedExtraCount += 1
    }
    continue
  }

  if (canonicalOnly) {
    const canonicalKey = card.oracle_id || card.name

    if (seenOracleIds.has(canonicalKey)) {
      skippedCount += 1
      skippedDuplicateCount += 1
      continue
    }

    seenOracleIds.add(canonicalKey)
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
    canonicalOnly ? `duplicate_oracle_skipped=${skippedDuplicateCount}` : null,
    playableOnly ? `extras_skipped=${skippedExtraCount}` : null,
    `file=${inputFile}`,
  ]
    .filter(Boolean)
    .join(' '),
)

async function flushBatch() {
  if (batch.length === 0) {
    return
  }

  const currentBatch = batch
  batch = []

  if (dryRun) {
    importedCount += currentBatch.length
    console.log(`[dry-run] prepared ${currentBatch.length} cards, latest: ${currentBatch.at(-1)?.name}`)
    return
  }

  await upsertBatchWithRetry(currentBatch)

  importedCount += currentBatch.length
  console.log(`Imported ${importedCount} cards, latest: ${currentBatch.at(-1)?.name}`)
}

async function upsertBatchWithRetry(currentBatch) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const { error } = await supabase.from('cards').upsert(currentBatch, {
      onConflict: 'id',
      ignoreDuplicates: false,
    })

    if (!error) {
      return
    }

    const message = getSupabaseErrorMessage(error)
    const isLastAttempt = attempt === maxAttempts

    if (isLastAttempt) {
      throw new Error(
        [
          `Failed to upsert ${currentBatch.length} cards after ${maxAttempts} attempts.`,
          `Latest card: ${currentBatch.at(-1)?.name ?? 'unknown'}.`,
          message,
          'Try rerunning with a smaller batch, for example: npm run import:cards -- --batch-size 25',
        ].join(' '),
      )
    }

    const delayMs = 750 * attempt
    console.warn(
      `Upsert failed for ${currentBatch.length} cards, attempt ${attempt}/${maxAttempts}. Retrying in ${delayMs}ms. ${message}`,
    )
    await wait(delayMs)
  }
}

function getSupabaseErrorMessage(error) {
  const parts = [
    error.message ? `message=${error.message}` : null,
    error.code ? `code=${error.code}` : null,
    error.details ? `details=${error.details}` : null,
    error.hint ? `hint=${error.hint}` : null,
  ].filter(Boolean)

  if (error.cause) {
    parts.push(`cause=${String(error.cause)}`)
  }

  return parts.join(' ')
}

function wait(delayMs) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, delayMs)
  })
}

function getSkipReason(card) {
  if (!card || card.object !== 'card') {
    return 'invalid'
  }

  if (!includeNonEnglish && card.lang && card.lang !== 'en') {
    return 'language'
  }

  if (!includeDigital && card.digital === true) {
    return 'digital'
  }

  if (!card.id || !card.name) {
    return 'invalid'
  }

  if (playableOnly && isExtraCardObject(card)) {
    return 'extra'
  }

  return null
}

function isExtraCardObject(card) {
  const layout = String(card.layout ?? '').toLowerCase()
  const typeLine = String(card.type_line ?? '').toLowerCase()
  const name = String(card.name ?? '').toLowerCase()

  if (
    [
      'token',
      'double_faced_token',
      'emblem',
      'planar',
      'scheme',
      'vanguard',
      'art_series',
    ].includes(layout)
  ) {
    return true
  }

  if (
    typeLine === 'card' ||
    typeLine.includes('token') ||
    typeLine.includes('emblem') ||
    typeLine.includes('plane') ||
    typeLine.includes('phenomenon') ||
    typeLine.includes('scheme') ||
    typeLine.includes('vanguard') ||
    typeLine.includes('dungeon') ||
    typeLine.includes('sticker')
  ) {
    return true
  }

  return name.includes('checklist card')
}

function mapScryfallCardToRow(card) {
  const imageUrl = getImageUrl(card)
  const power = parseIntegerStat(card.power)
  const toughness = parseIntegerStat(card.toughness)
  const powerToughness = getPowerToughness(card, power, toughness)

  return removeUndefinedValues({
    id: card.id,
    oracle_id: card.oracle_id,
    name: card.name,
    mana_cost: getManaCost(card),
    type_line: getTypeLine(card),
    oracle_text: getOracleText(card),
    power_toughness: powerToughness,
    keywords: Array.isArray(card.keywords) ? card.keywords : [],
    image_url: imageUrl,
    power,
    toughness,
  })
}

function getImageUrl(card) {
  return (
    card.image_uris?.normal ??
    card.card_faces?.[0]?.image_uris?.normal ??
    card.image_uris?.large ??
    card.card_faces?.[0]?.image_uris?.large ??
    null
  )
}

function getManaCost(card) {
  return card.mana_cost || card.card_faces?.map((face) => face.mana_cost).filter(Boolean).join(' // ') || null
}

function getTypeLine(card) {
  return card.type_line || card.card_faces?.map((face) => face.type_line).filter(Boolean).join(' // ') || null
}

function getOracleText(card) {
  if (card.oracle_text) {
    return card.oracle_text
  }

  const faceTexts = card.card_faces
    ?.map((face) => [face.name, face.oracle_text].filter(Boolean).join('\n'))
    .filter(Boolean)

  return faceTexts?.length ? faceTexts.join('\n\n//\n\n') : null
}

function parseIntegerStat(value) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null
  }

  const normalizedValue = String(value)

  if (!/^-?\d+$/.test(normalizedValue)) {
    return null
  }

  return Number(normalizedValue)
}

function getPowerToughness(card, power, toughness) {
  if (card.power && card.toughness) {
    return `${card.power}/${card.toughness}`
  }

  if (power !== null && toughness !== null) {
    return `${power}/${toughness}`
  }

  return null
}

function removeUndefinedValues(row) {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined))
}

function parseArgs(args) {
  const parsed = {}

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === '--dry-run') {
      parsed.dryRun = true
      continue
    }

    if (arg === '--include-digital') {
      parsed.includeDigital = true
      continue
    }

    if (arg === '--include-non-english') {
      parsed.includeNonEnglish = true
      continue
    }

    if (arg === '--all-prints') {
      parsed.allPrints = true
      continue
    }

    if (arg === '--include-extras') {
      parsed.includeExtras = true
      continue
    }

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
  if (!existsSync(path)) {
    return
  }

  const envFile = readFileSync(path, 'utf8')

  for (const line of envFile.split(/\r?\n/)) {
    const trimmedLine = line.trim()

    if (!trimmedLine || trimmedLine.startsWith('#')) {
      continue
    }

    const separatorIndex = trimmedLine.indexOf('=')

    if (separatorIndex < 0) {
      continue
    }

    const key = trimmedLine.slice(0, separatorIndex).trim()
    const value = trimmedLine.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, '')

    if (!process.env[key]) {
      process.env[key] = value
    }
  }
}

function getRequiredEnv(...keys) {
  for (const key of keys) {
    if (process.env[key]) {
      return process.env[key]
    }
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

      if (isEscaped) {
        isEscaped = false
        continue
      }

      if (char === '\\' && isInString) {
        isEscaped = true
        continue
      }

      if (char === '"') {
        isInString = !isInString
        continue
      }

      if (isInString) {
        continue
      }

      if (char === '{') {
        depth += 1
      } else if (char === '}') {
        depth -= 1
      }

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
