// Deck import orchestration: parse decklist → resolve to oracle_ids → persist a
// co_decks row + its co_deck_cards. Each import creates a NEW deck (decks are not
// account-wide snapshots like the collection); de-duping re-imports is a later
// concern. DB writes go through the caller's RLS-scoped client.

import type { SupabaseClient } from '@supabase/supabase-js'

import { analyzeDeck } from './analyze-deck'
import { loadOracleMeta } from './deck-loader'
import { parseDecklist } from './parsers/decklist'
import { buildPrintingLookup, resolveOracleId } from './resolve'
import type { DeckImportResult, ParsedDeckCard, PrintingLookup, UnmatchedRow } from './types'

const UNMATCHED_SAMPLE_CAP = 200
const INSERT_CHUNK = 500

interface DeckImportOptions {
  name?: string | null
  source?: string | null
  /** Original deck URL (Moxfield/Archidekt) — stored so the deck can be re-synced later. */
  sourceUrl?: string | null
}

export async function importDeck(
  supabase: SupabaseClient,
  userId: string,
  text: string,
  options: DeckImportOptions = {},
): Promise<{ result: DeckImportResult; error?: string }> {
  const { cards, errors: parseErrors } = parseDecklist(text)
  const deckName = (options.name ?? '').trim() || 'Imported deck'

  if (cards.length === 0) {
    return { error: parseErrors[0] ?? 'No cards found in the decklist.', result: emptyResult(deckName, parseErrors) }
  }

  const lookup = await buildPrintingLookup(supabase, cards.map((c) => c.name))

  const matched: { oracleId: string; card: ParsedDeckCard }[] = []
  const unmatched: UnmatchedRow[] = []
  for (const card of cards) {
    const oracleId = resolveOracleId(card, lookup)
    if (oracleId) {
      matched.push({ oracleId, card })
    } else {
      unmatched.push({ name: card.name, setCode: card.setCode, collectorNum: card.collectorNum, quantity: card.quantity })
    }
  }

  const deckCards = aggregateDeckCards(matched)
  const commanders = deckCards.filter((c) => c.is_commander).map((c) => c.oracle_id)
  const colorIdentity = deriveColorIdentity(deckCards, commanders, lookup)

  // Create the deck row.
  const { data: deckRow, error: deckError } = await supabase
    .from('co_decks')
    .insert({
      user_id: userId,
      name: deckName,
      source: options.source ?? null,
      source_url: options.sourceUrl ?? null,
      color_identity: colorIdentity,
      commander_oracle_id: commanders[0] ?? null,
      partner_oracle_id: commanders[1] ?? null,
    })
    .select('id')
    .single()

  if (deckError || !deckRow) {
    return { error: `Could not create the deck: ${deckError?.message ?? 'unknown'}`, result: emptyResult(deckName, parseErrors) }
  }
  const deckId = deckRow.id as string

  // Insert the cards; roll the deck back by hand if any chunk fails.
  const rows = deckCards.map((c) => ({ ...c, deck_id: deckId }))
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const { error: cardError } = await supabase.from('co_deck_cards').insert(rows.slice(i, i + INSERT_CHUNK))
    if (cardError) {
      await supabase.from('co_decks').delete().eq('id', deckId)
      return { error: `Could not save the deck cards: ${cardError.message}`, result: emptyResult(deckName, parseErrors) }
    }
  }

  const cardsMatched = matched.reduce((sum, m) => sum + m.card.quantity, 0)
  const cardsUnmatched = unmatched.reduce((sum, u) => sum + u.quantity, 0)

  // Record the import for the dashboard's history (best-effort; never fail the import).
  await supabase
    .from('co_imports')
    .insert({
      user_id: userId,
      kind: 'deck',
      source: options.source ?? 'txt',
      filename: deckName,
      rows_total: cardsMatched + cardsUnmatched,
      rows_matched: cardsMatched,
      rows_unmatched: cardsUnmatched,
      unmatched: unmatched.slice(0, UNMATCHED_SAMPLE_CAP),
    })
    .then(undefined, () => {})

  return {
    result: {
      deckId,
      deckName,
      colorIdentity,
      cardsMatched,
      cardsUnmatched,
      unmatched: unmatched.slice(0, UNMATCHED_SAMPLE_CAP),
      commanderResolved: commanders.length > 0,
      parseErrors,
    },
  }
}

export interface DeckSyncResult {
  deckName: string
  cardsMatched: number
  cardsUnmatched: number
  unmatched: UnmatchedRow[]
  added: { name: string; qty: number }[]
  removed: { name: string; qty: number }[]
}

// Re-sync an EXISTING deck from a freshly fetched decklist: replace its cards,
// refresh identity/commander, and report what changed. The deck keeps its id
// (and therefore its analyses, links and history) — this is "the deck changed
// on Moxfield", not "import it again as a duplicate".
export async function syncDeckFromText(
  supabase: SupabaseClient,
  deckId: string,
  text: string,
): Promise<{ result?: DeckSyncResult; error?: string }> {
  const { data: deck } = await supabase.from('co_decks').select('id, name, commander_oracle_id').eq('id', deckId).maybeSingle()
  if (!deck) return { error: 'Deck not found.' }

  const { cards, errors: parseErrors } = parseDecklist(text)
  if (cards.length === 0) return { error: parseErrors[0] ?? 'No cards found in the fetched decklist.' }

  const lookup = await buildPrintingLookup(supabase, cards.map((c) => c.name))
  const matched: { oracleId: string; card: ParsedDeckCard }[] = []
  const unmatched: UnmatchedRow[] = []
  for (const card of cards) {
    const oracleId = resolveOracleId(card, lookup)
    if (oracleId) matched.push({ oracleId, card })
    else unmatched.push({ name: card.name, setCode: card.setCode, collectorNum: card.collectorNum, quantity: card.quantity })
  }

  const deckCards = aggregateDeckCards(matched)
  if (deckCards.length === 0) return { error: 'Nothing in the fetched list could be matched to a card.' }
  let commanders = deckCards.filter((c) => c.is_commander).map((c) => c.oracle_id)
  // A manually-set commander survives a sync whose fetched list carries no
  // commander marker — as long as the card is still in the deck.
  if (commanders.length === 0 && deck.commander_oracle_id) {
    const kept = deckCards.find((c) => c.oracle_id === (deck.commander_oracle_id as string))
    if (kept) {
      kept.is_commander = true
      commanders = [kept.oracle_id]
    }
  }
  const colorIdentity = deriveColorIdentity(deckCards, commanders, lookup)

  // Diff vs the current composition, BEFORE the replace.
  const { data: currentRows } = await supabase.from('co_deck_cards').select('oracle_id, quantity').eq('deck_id', deckId)
  const before = new Map<string, number>()
  for (const r of currentRows ?? []) before.set(r.oracle_id as string, (before.get(r.oracle_id as string) ?? 0) + (r.quantity as number))
  const afterQty = new Map<string, number>(deckCards.map((c) => [c.oracle_id, c.quantity]))
  const nameByOracle = new Map<string, string>(matched.map((m) => [m.oracleId, m.card.name]))

  const added: { name: string; qty: number }[] = []
  const removed: { name: string; qty: number }[] = []
  for (const [oracle, qty] of afterQty) {
    const delta = qty - (before.get(oracle) ?? 0)
    if (delta > 0) added.push({ name: nameByOracle.get(oracle) ?? oracle, qty: delta })
  }
  const removedIds = [...before.keys()].filter((o) => (before.get(o) ?? 0) > (afterQty.get(o) ?? 0))
  if (removedIds.length > 0) {
    const meta = await loadOracleMeta(supabase, removedIds)
    for (const oracle of removedIds) {
      removed.push({
        name: meta.get(oracle)?.name ?? nameByOracle.get(oracle) ?? oracle,
        qty: (before.get(oracle) ?? 0) - (afterQty.get(oracle) ?? 0),
      })
    }
  }

  // Replace the composition (same pattern as the collection snapshot import).
  const { error: deleteError } = await supabase.from('co_deck_cards').delete().eq('deck_id', deckId)
  if (deleteError) return { error: `Could not clear the old deck list: ${deleteError.message}` }
  const rows = deckCards.map((c) => ({ ...c, deck_id: deckId }))
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const { error: cardError } = await supabase.from('co_deck_cards').insert(rows.slice(i, i + INSERT_CHUNK))
    if (cardError) return { error: `Sync failed while saving cards (${cardError.message}) — re-run the sync to recover.` }
  }
  await supabase
    .from('co_decks')
    .update({
      color_identity: colorIdentity,
      commander_oracle_id: commanders[0] ?? null,
      partner_oracle_id: commanders[1] ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', deckId)

  // Composition changed → refresh the cached score (best-effort).
  await analyzeDeck(supabase, deckId, { persist: true }).catch(() => {})

  const bigFirst = (a: { qty: number }, b: { qty: number }) => b.qty - a.qty
  return {
    result: {
      deckName: deck.name as string,
      cardsMatched: matched.reduce((sum, m) => sum + m.card.quantity, 0),
      cardsUnmatched: unmatched.reduce((sum, u) => sum + u.quantity, 0),
      unmatched: unmatched.slice(0, UNMATCHED_SAMPLE_CAP),
      added: added.sort(bigFirst),
      removed: removed.sort(bigFirst),
    },
  }
}

// One row per oracle_id (the deck_cards PK), summing quantity; a card is the
// commander if any of its occurrences was flagged as one.
function aggregateDeckCards(matched: { oracleId: string; card: ParsedDeckCard }[]) {
  const byOracle = new Map<string, { oracle_id: string; quantity: number; is_commander: boolean; category: string | null }>()
  for (const { oracleId, card } of matched) {
    const existing = byOracle.get(oracleId)
    if (existing) {
      existing.quantity += card.quantity
      existing.is_commander = existing.is_commander || card.isCommander
      existing.category = existing.category ?? card.category
      continue
    }
    byOracle.set(oracleId, {
      oracle_id: oracleId,
      quantity: card.quantity,
      is_commander: card.isCommander,
      category: card.category,
    })
  }
  return [...byOracle.values()]
}

// A legal deck's color identity equals its commander's; fall back to the union of
// all cards when no commander was resolved (e.g. a plain 60-card txt list).
function deriveColorIdentity(
  deckCards: { oracle_id: string }[],
  commanders: string[],
  lookup: PrintingLookup,
): string[] {
  const source = commanders.length > 0 ? commanders : deckCards.map((c) => c.oracle_id)
  const colors = new Set<string>()
  for (const oracleId of source) {
    for (const c of lookup.colorIdentityByOracle.get(oracleId) ?? []) colors.add(c)
  }
  return [...colors].sort()
}

function emptyResult(deckName: string, parseErrors: string[]): DeckImportResult {
  return {
    deckId: null,
    deckName,
    colorIdentity: [],
    cardsMatched: 0,
    cardsUnmatched: 0,
    unmatched: [],
    commanderResolved: false,
    parseErrors,
  }
}
