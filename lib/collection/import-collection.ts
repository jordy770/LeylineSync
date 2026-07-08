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
  CollectionDiff,
  CollectionImportResult,
  ResolvedCollectionRow,
  UnmatchedRow,
} from './types'

const UNMATCHED_SAMPLE_CAP = 200
const INSERT_CHUNK = 500
const DIFF_SAMPLE_CAP = 12

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

  // Snapshot the outgoing collection (per-oracle totals) so the report can show
  // what this re-import changed. Read-only; a first import diffs against nothing.
  const before = new Map<string, { name: string; qty: number }>()
  for (let from = 0; ; from += 1000) {
    const { data: prevRows } = await supabase
      .from('co_collection_items')
      .select('oracle_id, name, quantity')
      .eq('user_id', userId)
      .range(from, from + 999)
    for (const r of prevRows ?? []) {
      const cur = before.get(r.oracle_id)
      if (cur) cur.qty += r.quantity
      else before.set(r.oracle_id, { name: r.name, qty: r.quantity })
    }
    if (!prevRows || prevRows.length < 1000) break
  }

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

  const after = new Map<string, { name: string; qty: number }>()
  for (const row of matched) {
    const cur = after.get(row.oracleId)
    if (cur) cur.qty += row.quantity
    else after.set(row.oracleId, { name: row.name, qty: row.quantity })
  }

  // The collection changed, so every deck's cached upgrade counts are stale —
  // reset them to "never scanned" (NULL) so the dashboard doesn't show numbers
  // the next scan would contradict. Best-effort; never fails the import.
  const { data: deckRows } = await supabase.from('co_decks').select('id').eq('user_id', userId)
  const deckIds = (deckRows ?? []).map((d) => d.id as string)
  if (deckIds.length > 0) {
    await supabase
      .from('co_deck_analyses')
      .update({ free_upgrades: null, occupied_upgrades: null, scanned_at: null })
      .in('deck_id', deckIds)
      .then(undefined, () => {})
  }

  return {
    result: {
      rowsTotal: rowsMatched + rowsUnmatched,
      rowsMatched,
      rowsUnmatched,
      unmatched: unmatched.slice(0, UNMATCHED_SAMPLE_CAP),
      parseErrors,
      importId: importError ? null : (importRow?.id ?? null),
      diff: before.size === 0 ? null : diffCollections(before, after),
    },
  }
}

// Pure: compare per-oracle totals of the replaced snapshot vs the new one.
export function diffCollections(
  before: Map<string, { name: string; qty: number }>,
  after: Map<string, { name: string; qty: number }>,
): CollectionDiff {
  const added: { name: string; qty: number }[] = []
  const removed: { name: string; qty: number }[] = []
  let addedUnique = 0
  let removedUnique = 0
  let qtyAdded = 0
  let qtyRemoved = 0

  for (const [oracle, next] of after) {
    const prev = before.get(oracle)
    const delta = next.qty - (prev?.qty ?? 0)
    if (!prev) addedUnique += 1
    if (delta > 0) {
      qtyAdded += delta
      added.push({ name: next.name, qty: delta })
    }
  }
  for (const [oracle, prev] of before) {
    const next = after.get(oracle)
    const delta = prev.qty - (next?.qty ?? 0)
    if (!next) removedUnique += 1
    if (delta > 0) {
      qtyRemoved += delta
      removed.push({ name: prev.name, qty: delta })
    }
  }

  const bigFirst = (a: { qty: number }, b: { qty: number }) => b.qty - a.qty
  return {
    addedUnique,
    removedUnique,
    qtyAdded,
    qtyRemoved,
    added: added.sort(bigFirst).slice(0, DIFF_SAMPLE_CAP),
    removed: removed.sort(bigFirst).slice(0, DIFF_SAMPLE_CAP),
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
  return { rowsTotal: 0, rowsMatched: 0, rowsUnmatched: 0, unmatched: [], parseErrors, importId: null, diff: null }
}
