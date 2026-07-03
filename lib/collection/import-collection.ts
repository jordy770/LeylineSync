// Collection import orchestration: parse → resolve to oracle_id → persist.
//
// A ManaBox export is treated as a FULL SNAPSHOT of the user's collection, so an
// import REPLACES the user's existing co_collection_items (delete-then-insert)
// rather than merging — re-uploading after selling cards correctly shrinks the
// collection. The DB writes go through the caller's RLS-scoped client, so a user
// can only ever touch their own rows.

import type { SupabaseClient } from '@supabase/supabase-js'

import { parseManaboxCsv } from './parsers/manabox'
import { buildPrintingLookup, resolveOracleId } from './resolve'
import type {
  CollectionImportResult,
  ResolvedCollectionRow,
  UnmatchedRow,
} from './types'

const UNMATCHED_SAMPLE_CAP = 200
const INSERT_CHUNK = 500

export async function importManaboxCollection(
  supabase: SupabaseClient,
  userId: string,
  csvText: string,
  filename: string | null,
): Promise<{ result: CollectionImportResult; error?: string }> {
  const { rows, errors: parseErrors } = parseManaboxCsv(csvText)

  if (rows.length === 0) {
    return {
      error: parseErrors[0] ?? 'No rows found in the file.',
      result: emptyResult(parseErrors),
    }
  }

  const lookup = await buildPrintingLookup(supabase, rows.map((r) => r.name))

  const matched: ResolvedCollectionRow[] = []
  const unmatched: UnmatchedRow[] = []
  for (const row of rows) {
    const oracleId = resolveOracleId(row, lookup)
    if (oracleId) {
      matched.push({ ...row, oracleId })
    } else {
      unmatched.push({
        name: row.name,
        setCode: row.setCode,
        collectorNum: row.collectorNum,
        quantity: row.quantity,
      })
    }
  }

  const items = aggregateItems(userId, matched)

  // Replace the snapshot: clear, then insert fresh.
  const { error: deleteError } = await supabase.from('co_collection_items').delete().eq('user_id', userId)
  if (deleteError) {
    return { error: `Could not clear the previous collection: ${deleteError.message}`, result: emptyResult(parseErrors) }
  }

  for (let i = 0; i < items.length; i += INSERT_CHUNK) {
    const chunk = items.slice(i, i + INSERT_CHUNK)
    const { error: insertError } = await supabase.from('co_collection_items').insert(chunk)
    if (insertError) {
      return { error: `Could not save the collection: ${insertError.message}`, result: emptyResult(parseErrors) }
    }
  }

  const rowsUnmatched = unmatched.reduce((sum, u) => sum + u.quantity, 0)
  const rowsMatched = matched.reduce((sum, m) => sum + m.quantity, 0)

  const { data: importRow, error: importError } = await supabase
    .from('co_imports')
    .insert({
      user_id: userId,
      kind: 'collection',
      source: 'manabox',
      filename,
      rows_total: rowsMatched + rowsUnmatched,
      rows_matched: rowsMatched,
      rows_unmatched: rowsUnmatched,
      unmatched: unmatched.slice(0, UNMATCHED_SAMPLE_CAP),
    })
    .select('id')
    .single()

  return {
    result: {
      rowsTotal: rowsMatched + rowsUnmatched,
      rowsMatched,
      rowsUnmatched,
      unmatched: unmatched.slice(0, UNMATCHED_SAMPLE_CAP),
      parseErrors,
      importId: importError ? null : (importRow?.id ?? null),
    },
  }
}

// Collapse rows that map to the same physical-distinct key, summing quantity, so
// the insert never violates the co_collection_items unique index.
function aggregateItems(userId: string, matched: ResolvedCollectionRow[]) {
  const byKey = new Map<string, Record<string, unknown>>()
  for (const row of matched) {
    const key = [
      row.oracleId,
      row.finish,
      row.language,
      row.condition ?? '',
      row.setCode ?? '',
      row.collectorNum ?? '',
      row.binderName ?? '',
    ].join('|')

    const existing = byKey.get(key)
    if (existing) {
      existing.quantity = (existing.quantity as number) + row.quantity
      continue
    }

    byKey.set(key, {
      user_id: userId,
      oracle_id: row.oracleId,
      scryfall_id: row.scryfallId && isUuid(row.scryfallId) ? row.scryfallId : null,
      name: row.name,
      set_code: row.setCode,
      collector_num: row.collectorNum,
      quantity: row.quantity,
      finish: row.finish,
      language: row.language,
      condition: row.condition,
      binder_type: row.binderType,
      binder_name: row.binderName,
    })
  }
  return [...byKey.values()]
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim())
}

function emptyResult(parseErrors: string[]): CollectionImportResult {
  return { rowsTotal: 0, rowsMatched: 0, rowsUnmatched: 0, unmatched: [], parseErrors, importId: null }
}
