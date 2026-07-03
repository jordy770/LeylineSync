// Collection Insights — collection-WIDE analysis (across all decks), the counterpart
// to the per-deck scanner. Reuses the same scoring so numbers stay consistent:
//   * Unused staples — strong binder cards sitting in no deck at all.
//   * Perfect fits   — the single best free upgrade the binder offers EACH deck.
// The per-deck matching is pure + tested; the orchestrator loads the binder once and
// reuses loadDeckForScoring per deck.

import type { SupabaseClient } from '@supabase/supabase-js'

import { rankStaples } from './dashboard'
import type { StapleCard } from './dashboard'
import { loadBinderNames, loadDeckForScoring, loadOracleMeta, loadTags } from './deck-loader'
import { computePowerScore } from './power-score'
import type { DeckNeed } from './power-score'
import { buildDeckContext, commanderSynergy, confidence, curveFit, themeImpact } from './scoring'
import type { DeckContext, ThemeImpact } from './scoring'
import type { CardTag } from './synergy/tagger'

export interface FitCandidate {
  oracleId: string
  name: string
  cmc: number
  colorIdentity: string[]
  priceEur: number | null
  typeLine: string
  tags: CardTag[]
}

export interface DeckFit {
  oracleId: string
  name: string
  tag: string
  confidence: number
  themeImpact: ThemeImpact
}

export interface PerfectFit extends DeckFit {
  deckId: string
  deckName: string
  priceEur: number | null
  binderNames?: string[]
}

export interface CollectionInsights {
  unusedStaples: StapleCard[]
  perfectFits: PerfectFit[]
  deckFitCounts: { deckId: string; deckName: string; fitCount: number }[]
}

/** Pure: rank the binder candidates that fit ONE deck (colour-legal, fills a need),
 *  each scored at its best-fitting need. */
export function rankDeckFits(
  needs: DeckNeed[],
  ctx: DeckContext,
  deckIdentity: string[],
  deckOracleIds: Set<string>,
  candidates: FitCandidate[],
): DeckFit[] {
  const out: DeckFit[] = []
  for (const c of candidates) {
    if (deckOracleIds.has(c.oracleId)) continue
    if (!c.colorIdentity.every((x) => deckIdentity.includes(x))) continue

    let best: DeckFit | null = null
    for (const need of needs) {
      const w = c.tags.find((t) => t.tag === need.tag)?.weight ?? 0
      if (w <= 0) continue
      const conf = confidence({
        needGap: need.gap,
        target: need.target,
        roleWeight: w,
        replacementDelta: w,
        commanderSynergy: commanderSynergy(c.tags, ctx.commanderTags),
        themeImpact: themeImpact(c.tags, ctx.themeTags),
        curveFit: curveFit(c.cmc, ctx.avgMv),
        availability: 'free',
        hasCommander: ctx.hasCommander,
      })
      if (!best || conf > best.confidence) {
        best = { oracleId: c.oracleId, name: c.name, tag: need.tag, confidence: conf, themeImpact: themeImpact(c.tags, ctx.themeTags) }
      }
    }
    if (best) out.push(best)
  }
  return out.sort((a, b) => b.confidence - a.confidence)
}

export async function getCollectionInsights(supabase: SupabaseClient, userId: string): Promise<CollectionInsights> {
  const { data: decks } = await supabase
    .from('co_decks')
    .select('id, name, color_identity')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })

  // Binder, loaded once: free copies with tags + metadata.
  const { data: avail } = await supabase
    .from('co_card_availability')
    .select('oracle_id, free_qty')
    .eq('user_id', userId)
  const freeIds = (avail ?? []).filter((a) => Number(a.free_qty ?? 0) > 0).map((a) => a.oracle_id as string)

  const [binderMeta, binderTags, binderNames] = await Promise.all([
    loadOracleMeta(supabase, freeIds),
    loadTags(supabase, freeIds),
    loadBinderNames(supabase, userId, freeIds),
  ])
  const binder: FitCandidate[] = freeIds.map((id) => {
    const m = binderMeta.get(id)
    return {
      oracleId: id,
      name: m?.name ?? id,
      cmc: m?.cmc ?? 0,
      colorIdentity: m?.colorIdentity ?? [],
      priceEur: m?.priceEur ?? null,
      typeLine: m?.typeLine ?? '',
      tags: binderTags.get(id) ?? [],
    }
  })

  // Every oracle used in ANY of the user's decks — to find truly unused cards.
  const usedInDecks = new Set<string>()
  if ((decks ?? []).length > 0) {
    const { data: deckCardRows } = await supabase
      .from('co_deck_cards')
      .select('oracle_id, co_decks!inner(user_id)')
      .limit(20000)
    for (const r of deckCardRows ?? []) {
      const dk = Array.isArray(r.co_decks) ? r.co_decks[0] : r.co_decks
      if (dk?.user_id === userId) usedInDecks.add(r.oracle_id as string)
    }
  }

  const perfectFits: PerfectFit[] = []
  const deckFitCounts: { deckId: string; deckName: string; fitCount: number }[] = []

  for (const deck of decks ?? []) {
    const loaded = await loadDeckForScoring(supabase, deck.id as string)
    if (!loaded.found) continue
    const power = computePowerScore(loaded.scoreCards)
    if (power.needs.length === 0) {
      deckFitCounts.push({ deckId: deck.id as string, deckName: deck.name as string, fitCount: 0 })
      continue
    }
    const ctx = buildDeckContext(loaded.scoreCards, power.avgMv)
    const fits = rankDeckFits(power.needs, ctx, loaded.deckIdentity, loaded.deckOracleIds, binder)
    deckFitCounts.push({ deckId: deck.id as string, deckName: deck.name as string, fitCount: fits.length })
    if (fits[0]) {
      perfectFits.push({
        ...fits[0],
        deckId: deck.id as string,
        deckName: deck.name as string,
        priceEur: binderMeta.get(fits[0].oracleId)?.priceEur ?? null,
        binderNames: binderNames.get(fits[0].oracleId) ?? [],
      })
    }
  }

  const unusedStaples = rankStaples(
    binder.filter((c) => !usedInDecks.has(c.oracleId)),
    20,
  ).map((s) => ({ ...s, binderNames: binderNames.get(s.oracleId) ?? [] }))

  perfectFits.sort((a, b) => b.confidence - a.confidence)
  return { unusedStaples, perfectFits, deckFitCounts }
}
