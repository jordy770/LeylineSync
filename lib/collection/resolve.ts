// Shared Scryfall-identity resolution for the importers (collection + deck).
//
// Both importers need the same thing: turn an imported card line into an oracle_id
// against co_card_printings, most-precise key first. Kept separate from any single
// importer so the matching rules live in one place.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { PrintingLookup } from './types'

// Keep the GET URL under the gateway's URI limit (names go in the query string).
const NAME_QUERY_CHUNK = 100

/** The minimum a row needs to be resolvable. */
export interface ResolvableRow {
  name: string
  setCode: string | null
  collectorNum: string | null
  scryfallId?: string | null
}

/** Pure: pick the oracle_id for a row, most-precise key first. */
export function resolveOracleId(row: ResolvableRow, lookup: PrintingLookup): string | null {
  if (row.scryfallId) {
    const byId = lookup.byScryfallId.get(row.scryfallId.toLowerCase())
    if (byId) return byId
  }
  if (row.setCode && row.collectorNum) {
    const key = `${row.setCode.toLowerCase()}|${row.collectorNum.toLowerCase()}`
    const bySet = lookup.bySetCollector.get(key)
    if (bySet) return bySet
  }
  return lookup.byName.get(row.name.trim().toLowerCase()) ?? null
}

/** Fetch the printings referenced by `names` and build the resolution maps. */
export async function buildPrintingLookup(
  supabase: SupabaseClient,
  names: string[],
): Promise<PrintingLookup> {
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))]

  const byScryfallId = new Map<string, string>()
  const bySetCollector = new Map<string, string>()
  const byName = new Map<string, string>()
  const colorIdentityByOracle = new Map<string, string[]>()

  for (let i = 0; i < unique.length; i += NAME_QUERY_CHUNK) {
    const chunk = unique.slice(i, i + NAME_QUERY_CHUNK)
    const { data, error } = await supabase
      .from('co_card_printings')
      .select('scryfall_id, oracle_id, set_code, collector_num, name, color_identity')
      .in('name', chunk)

    if (error) throw new Error(`Card lookup failed: ${error.message}`)

    for (const p of (data ?? []) as PrintingRow[]) {
      byScryfallId.set(p.scryfall_id.toLowerCase(), p.oracle_id)
      if (p.set_code && p.collector_num) {
        bySetCollector.set(`${p.set_code.toLowerCase()}|${p.collector_num.toLowerCase()}`, p.oracle_id)
      }
      // First printing wins for a given name; all printings of a card share oracle_id.
      const nameKey = p.name.trim().toLowerCase()
      if (!byName.has(nameKey)) byName.set(nameKey, p.oracle_id)
      if (!colorIdentityByOracle.has(p.oracle_id)) {
        colorIdentityByOracle.set(p.oracle_id, Array.isArray(p.color_identity) ? p.color_identity : [])
      }
    }
  }

  return { byScryfallId, bySetCollector, byName, colorIdentityByOracle }
}

interface PrintingRow {
  scryfall_id: string
  oracle_id: string
  set_code: string | null
  collector_num: string | null
  name: string
  color_identity: string[] | null
}
