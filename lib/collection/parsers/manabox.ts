// ManaBox collection CSV parser — pure, no I/O.
//
// ManaBox's export columns vary by version and by whether the user uses binders,
// so columns are detected by (normalized) header name rather than fixed position.
// The only hard requirement is a "Name" column. A "Scryfall ID" column, when
// present, gives the most precise match downstream; Set code + Collector number is
// the fallback; the card name is the last resort.

import type { BinderType, Finish, ParsedCollectionRow, ParseResult } from '../types'

// Header synonyms → canonical field. Compared lower-cased and trimmed.
const HEADER_ALIASES: Record<keyof ColumnIndex, string[]> = {
  name: ['name', 'card name'],
  quantity: ['quantity', 'qty', 'count'],
  setCode: ['set code', 'setcode', 'set'],
  collectorNum: ['collector number', 'collector_number', 'collector num', 'collector', 'card number'],
  foil: ['foil', 'finish', 'printing'],
  language: ['language', 'lang'],
  condition: ['condition'],
  binderType: ['binder type', 'binder_type', 'binder'],
  binderName: ['binder name', 'binder_name'],
  scryfallId: ['scryfall id', 'scryfall_id', 'scryfallid'],
}

interface ColumnIndex {
  name: number
  quantity: number
  setCode: number
  collectorNum: number
  foil: number
  language: number
  condition: number
  binderType: number
  binderName: number
  scryfallId: number
}

export function parseManaboxCsv(text: string): ParseResult {
  const errors: string[] = []
  const records = parseCsv(text)

  if (records.length === 0) {
    return { rows: [], errors: ['The file is empty.'] }
  }

  const header = records[0].map((cell) => cell.trim().toLowerCase())
  const cols = mapColumns(header)

  if (cols.name < 0) {
    return { rows: [], errors: ['No "Name" column found — is this a ManaBox CSV export?'] }
  }

  const rows: ParsedCollectionRow[] = []
  for (let i = 1; i < records.length; i += 1) {
    const record = records[i]
    // Skip blank trailing lines.
    if (record.length === 0 || record.every((cell) => cell.trim() === '')) continue

    const name = cell(record, cols.name).trim()
    if (!name) {
      errors.push(`Row ${i + 1}: no card name — skipped.`)
      continue
    }

    rows.push({
      name,
      quantity: parseQuantity(cell(record, cols.quantity)),
      setCode: nullable(cell(record, cols.setCode)),
      collectorNum: nullable(cell(record, cols.collectorNum)),
      finish: parseFinish(cell(record, cols.foil)),
      language: nullable(cell(record, cols.language)) ?? 'en',
      condition: nullable(cell(record, cols.condition)),
      binderType: parseBinderType(cell(record, cols.binderType)),
      binderName: nullable(cell(record, cols.binderName)),
      scryfallId: nullable(cell(record, cols.scryfallId)),
    })
  }

  return { rows, errors }
}

function mapColumns(header: string[]): ColumnIndex {
  const find = (aliases: string[]) => header.findIndex((h) => aliases.includes(h))
  return {
    name: find(HEADER_ALIASES.name),
    quantity: find(HEADER_ALIASES.quantity),
    setCode: find(HEADER_ALIASES.setCode),
    collectorNum: find(HEADER_ALIASES.collectorNum),
    foil: find(HEADER_ALIASES.foil),
    language: find(HEADER_ALIASES.language),
    condition: find(HEADER_ALIASES.condition),
    binderType: find(HEADER_ALIASES.binderType),
    binderName: find(HEADER_ALIASES.binderName),
    scryfallId: find(HEADER_ALIASES.scryfallId),
  }
}

function cell(record: string[], index: number): string {
  if (index < 0 || index >= record.length) return ''
  return record[index] ?? ''
}

function nullable(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function parseQuantity(value: string): number {
  const n = Number.parseInt(value.trim(), 10)
  return Number.isFinite(n) && n > 0 ? n : 1
}

function parseFinish(value: string): Finish {
  const v = value.trim().toLowerCase()
  if (v.includes('etched')) return 'etched'
  // ManaBox uses "normal"/"foil"/"etched"; tolerate boolean-ish exports too.
  if (v === 'foil' || v === 'true' || v === '1' || v === 'yes') return 'foil'
  return 'nonfoil'
}

function parseBinderType(value: string): BinderType {
  const v = value.trim().toLowerCase()
  if (v === 'deck') return 'deck'
  if (v === 'list') return 'list'
  return 'binder'
}

// Minimal RFC-4180-ish CSV reader: handles quoted fields, escaped quotes (""),
// commas inside quotes, and both LF and CRLF line endings. Returns rows of cells.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  // Strip a UTF-8 BOM if present.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (char === '\r') {
      // swallow; the \n (if any) finishes the row
    } else {
      field += char
    }
  }

  // Flush the final field/row if the file didn't end with a newline.
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows
}
