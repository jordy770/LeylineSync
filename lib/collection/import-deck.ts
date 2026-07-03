// Deck import orchestration: parse decklist → resolve to oracle_ids → persist a
// co_decks row + its co_deck_cards. Each import creates a NEW deck (decks are not
// account-wide snapshots like the collection); de-duping re-imports is a later
// concern. DB writes go through the caller's RLS-scoped client.

import type { SupabaseClient } from '@supabase/supabase-js'

import { parseDecklist } from './parsers/decklist'
import { buildPrintingLookup, resolveOracleId } from './resolve'
import type { DeckImportResult, ParsedDeckCard, PrintingLookup, UnmatchedRow } from './types'

const UNMATCHED_SAMPLE_CAP = 200
const INSERT_CHUNK = 500

interface DeckImportOptions {
  name?: string | null
  source?: string | null
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
