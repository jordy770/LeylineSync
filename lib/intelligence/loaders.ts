// IO adapters for the Intelligence Engine — the ONLY place in lib/intelligence
// that talks to Supabase. Loads oracle identities (incl. oracle_text/keywords,
// which the collection loaders don't fetch), runs the pure analyzers, and
// assembles the Collection Intelligence view. RLS scopes every read.

import type { SupabaseClient } from '@supabase/supabase-js'

import { listConflicts } from '../collection/conflicts'
import { classifyCard } from './card-engine'
import { arbitrateConflict, type Arbitration, type ArbiterDeck } from './conflict-arbiter'
import { analyzeDeckRoles, type DeckIntelligence } from './deck-analyzer'
import type { CardInput } from './models'

interface OracleRow {
  oracle_id: string
  name: string
  type_line: string | null
  oracle_text: string | null
  keywords: string[] | null
  cmc: number | null
}

async function loadOracleRows(supabase: SupabaseClient, oracleIds: string[]): Promise<Map<string, OracleRow>> {
  const out = new Map<string, OracleRow>()
  for (let i = 0; i < oracleIds.length; i += 100) {
    const { data } = await supabase
      .from('co_card_oracle')
      .select('oracle_id, name, type_line, oracle_text, keywords, cmc')
      .in('oracle_id', oracleIds.slice(i, i + 100))
    for (const row of data ?? []) out.set(row.oracle_id, row)
  }
  return out
}

const toCardInput = (row: OracleRow): CardInput => ({
  name: row.name,
  typeLine: row.type_line ?? '',
  oracleText: row.oracle_text,
  keywords: row.keywords ?? [],
  cmc: Number(row.cmc ?? 0),
})

export interface DeckIntelligenceReport {
  deckId: string
  deckName: string
  commanderName: string | null
  intel: DeckIntelligence
}

export async function loadDeckIntelligence(
  supabase: SupabaseClient,
  deckId: string,
): Promise<DeckIntelligenceReport | null> {
  const { data: deck } = await supabase
    .from('co_decks')
    .select('id, name, commander_oracle_id')
    .eq('id', deckId)
    .maybeSingle()
  if (!deck) return null

  const { data: cards } = await supabase
    .from('co_deck_cards')
    .select('oracle_id, quantity, is_commander')
    .eq('deck_id', deckId)
  if (!cards || cards.length === 0) return null

  const oracles = await loadOracleRows(supabase, cards.map((c) => c.oracle_id))
  const deckCards = cards.flatMap((c) => {
    const row = oracles.get(c.oracle_id)
    return row ? [{ ...toCardInput(row), quantity: c.quantity, isCommander: c.is_commander }] : []
  })

  const commanderName = deck.commander_oracle_id
    ? (oracles.get(deck.commander_oracle_id)?.name ?? null)
    : null

  return { deckId: deck.id, deckName: deck.name, commanderName, intel: analyzeDeckRoles(deckCards) }
}

export interface ContestedCard {
  arbitration: Arbitration
  ownedQty: number
  committedQty: number
  /** Up to 3 free binder cards that share the card's strongest role — swaps for the losers. */
  alternatives: string[]
}

export interface CollectionIntelligence {
  decks: DeckIntelligenceReport[]
  contested: ContestedCard[]
}

export async function loadCollectionIntelligence(
  supabase: SupabaseClient,
  userId: string,
): Promise<CollectionIntelligence> {
  const { data: deckRows } = await supabase
    .from('co_decks')
    .select('id')
    .eq('user_id', userId)
  const reports = (
    await Promise.all((deckRows ?? []).map((d) => loadDeckIntelligence(supabase, d.id)))
  ).filter((r): r is DeckIntelligenceReport => r !== null)
  const reportById = new Map(reports.map((r) => [r.deckId, r]))

  const conflicts = await listConflicts(supabase, userId)
  const conflictOracles = await loadOracleRows(supabase, conflicts.map((c) => c.oracleId))

  const contested: ContestedCard[] = []
  for (const conflict of conflicts) {
    const row = conflictOracles.get(conflict.oracleId)
    if (!row) continue
    const profile = classifyCard(toCardInput(row))

    const decks: ArbiterDeck[] = conflict.decks.map((d) => {
      const report = reportById.get(d.id)
      return {
        id: d.id,
        name: d.name,
        commanderName: report?.commanderName ?? null,
        issues: report?.intel.issues ?? [],
      }
    })

    contested.push({
      arbitration: arbitrateConflict(profile, decks),
      ownedQty: conflict.ownedQty,
      committedQty: conflict.committedQty,
      alternatives: await findAlternatives(supabase, userId, conflict.oracleId, profile),
    })
  }

  return { decks: reports, contested }
}

/** Free binder cards sharing the conflict card's strongest legacy tag. */
async function findAlternatives(
  supabase: SupabaseClient,
  userId: string,
  oracleId: string,
  profile: ReturnType<typeof classifyCard>,
): Promise<string[]> {
  const topTag = profile.legacyTags[0]?.tag
  if (!topTag) return []

  const { data: tagRows } = await supabase
    .from('co_card_tags')
    .select('oracle_id, weight')
    .eq('tag', topTag)
    .gte('weight', 2)
    .neq('oracle_id', oracleId)
    .order('weight', { ascending: false })
    .limit(60)
  const candidateIds = (tagRows ?? []).map((t) => t.oracle_id)
  if (candidateIds.length === 0) return []

  const { data: availability } = await supabase
    .from('co_card_availability')
    .select('oracle_id, free_qty')
    .eq('user_id', userId)
    .gt('free_qty', 0)
    .in('oracle_id', candidateIds)
  const freeIds = (availability ?? []).map((a) => a.oracle_id).slice(0, 3)
  if (freeIds.length === 0) return []

  const names = await loadOracleRows(supabase, freeIds)
  return freeIds.map((id) => names.get(id)?.name).filter((n): n is string => Boolean(n))
}
