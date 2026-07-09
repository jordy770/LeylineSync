// ManaBox deck containers → LeylineSync decks.
//
// A ManaBox collection export tags every row with its container: rows with
// binder_type='deck' sit in one of the user's ManaBox decks and binder_name is
// that deck's name. The collection import already resolved every row to an
// oracle_id, so turning a container into a co_decks row is a pure regroup — no
// name matching, unlike the text decklist import. ManaBox does NOT mark the
// commander; the caller passes a confirmed pick, with the container's only
// legendary creature as the automatic fallback.

import type { SupabaseClient } from '@supabase/supabase-js'

import { analyzeDeck } from './analyze-deck'
import { loadOracleMeta } from './deck-loader'

const INSERT_CHUNK = 500

export interface CommanderCandidate {
  oracleId: string
  name: string
}

export interface DeckContainer {
  name: string
  totalCards: number
  uniqueCards: number
  /** Legendary creatures in the container — the plausible commanders. */
  candidates: CommanderCandidate[]
  /** The user already has a deck with this name — probably imported earlier. */
  alreadyImported: boolean
}

export interface ContainerImportResult {
  name: string
  deckId: string | null
  cardCount: number
  commanderResolved: boolean
  error?: string
}

interface ContainerRow {
  oracle_id: string
  name: string
  quantity: number
  binder_name: string | null
}

async function loadDeckContainerRows(supabase: SupabaseClient, userId: string): Promise<ContainerRow[]> {
  const rows: ContainerRow[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('co_collection_items')
      .select('oracle_id, name, quantity, binder_name')
      .eq('user_id', userId)
      .eq('binder_type', 'deck')
      .range(from, from + 999)
    if (error) throw new Error(`Deck container load failed: ${error.message}`)
    rows.push(...((data ?? []) as ContainerRow[]))
    if (!data || data.length < 1000) break
  }
  return rows
}

function isLegendaryCreature(typeLine: string): boolean {
  return typeLine.includes('Legendary') && typeLine.includes('Creature')
}

export async function listDeckContainers(supabase: SupabaseClient, userId: string): Promise<DeckContainer[]> {
  const rows = await loadDeckContainerRows(supabase, userId)
  if (rows.length === 0) return []

  // Group by container name; a nameless deck container can't become a deck.
  const byName = new Map<string, ContainerRow[]>()
  for (const row of rows) {
    const label = row.binder_name?.trim()
    if (!label) continue
    const list = byName.get(label)
    if (list) list.push(row)
    else byName.set(label, [row])
  }
  if (byName.size === 0) return []

  const meta = await loadOracleMeta(supabase, [...new Set(rows.map((r) => r.oracle_id))])

  const { data: existingDecks } = await supabase.from('co_decks').select('name').eq('user_id', userId)
  const existingNames = new Set((existingDecks ?? []).map((d) => (d.name as string).trim().toLowerCase()))

  const containers: DeckContainer[] = []
  for (const [name, list] of byName) {
    const unique = new Map<string, { name: string; qty: number }>()
    for (const row of list) {
      const entry = unique.get(row.oracle_id)
      if (entry) entry.qty += row.quantity
      else unique.set(row.oracle_id, { name: row.name, qty: row.quantity })
    }
    const candidates: CommanderCandidate[] = []
    for (const [oracleId, entry] of unique) {
      const typeLine = meta.get(oracleId)?.typeLine ?? ''
      if (isLegendaryCreature(typeLine)) candidates.push({ oracleId, name: entry.name })
    }
    candidates.sort((a, b) => a.name.localeCompare(b.name))
    containers.push({
      name,
      totalCards: [...unique.values()].reduce((sum, e) => sum + e.qty, 0),
      uniqueCards: unique.size,
      candidates,
      alreadyImported: existingNames.has(name.toLowerCase()),
    })
  }
  return containers.sort((a, b) => b.totalCards - a.totalCards || a.name.localeCompare(b.name))
}

export async function importDeckFromContainer(
  supabase: SupabaseClient,
  userId: string,
  containerName: string,
  commanderOracleId?: string | null,
): Promise<ContainerImportResult> {
  const name = containerName.trim()
  const fail = (error: string): ContainerImportResult => ({ name, deckId: null, cardCount: 0, commanderResolved: false, error })
  if (!name) return fail('Container name is required.')

  const rows = (await loadDeckContainerRows(supabase, userId)).filter((r) => r.binder_name?.trim() === name)
  if (rows.length === 0) return fail('No cards found in this deck container.')

  // One co_deck_cards row per oracle_id (the PK), summing copies across printings.
  const byOracle = new Map<string, number>()
  for (const row of rows) byOracle.set(row.oracle_id, (byOracle.get(row.oracle_id) ?? 0) + row.quantity)
  const oracleIds = [...byOracle.keys()]
  const meta = await loadOracleMeta(supabase, oracleIds)

  const legendaries = oracleIds.filter((id) => isLegendaryCreature(meta.get(id)?.typeLine ?? ''))
  let commander: string | null = null
  if (commanderOracleId) {
    if (!byOracle.has(commanderOracleId)) return fail('The chosen commander is not in this deck container.')
    commander = commanderOracleId
  } else if (legendaries.length === 1) {
    commander = legendaries[0]
  }

  // A legal deck's identity equals its commander's; union of all cards otherwise.
  const identitySource = commander ? [commander] : oracleIds
  const colorIdentity = [...new Set(identitySource.flatMap((id) => meta.get(id)?.colorIdentity ?? []))].sort()

  const { data: deckRow, error: deckError } = await supabase
    .from('co_decks')
    .insert({
      user_id: userId,
      name,
      source: 'manabox',
      color_identity: colorIdentity,
      commander_oracle_id: commander,
      partner_oracle_id: null,
    })
    .select('id')
    .single()
  if (deckError || !deckRow) return fail(`Could not create the deck: ${deckError?.message ?? 'unknown'}`)
  const deckId = deckRow.id as string

  const cardRows = oracleIds.map((oracle_id) => ({
    deck_id: deckId,
    oracle_id,
    quantity: byOracle.get(oracle_id) ?? 1,
    is_commander: oracle_id === commander,
  }))
  for (let i = 0; i < cardRows.length; i += INSERT_CHUNK) {
    const { error: cardError } = await supabase.from('co_deck_cards').insert(cardRows.slice(i, i + INSERT_CHUNK))
    if (cardError) {
      await supabase.from('co_decks').delete().eq('id', deckId)
      return fail(`Could not save the deck cards: ${cardError.message}`)
    }
  }

  const cardCount = [...byOracle.values()].reduce((sum, qty) => sum + qty, 0)

  // Record the import for the dashboard's history (best-effort; never fail the import).
  await supabase
    .from('co_imports')
    .insert({
      user_id: userId,
      kind: 'deck',
      source: 'manabox',
      filename: name,
      rows_total: cardCount,
      rows_matched: cardCount,
      rows_unmatched: 0,
      unmatched: [],
    })
    .then(undefined, () => {})

  await analyzeDeck(supabase, deckId, { persist: true }).catch(() => {})

  return { name, deckId, cardCount, commanderResolved: commander !== null }
}
