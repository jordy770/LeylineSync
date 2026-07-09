// Buy suggestions — the third pillar of the scanner (Free / Occupied / Buy). When a
// need can't be filled from the binder, suggest cards to purchase: not owned, colour-
// legal, within budget, ranked by synergy. The heavy lifting (anti-joins over the 33k
// pool) is the co_buy_candidates SQL function; this just shapes the result + links.

import type { SupabaseClient } from '@supabase/supabase-js'

import { loadDeckForScoring } from './deck-loader'
import { computePowerScore } from './power-score'
import type { DeckNeed } from './power-score'
import { buildDeckContext, commanderSynergy, confidence, curveFit, themeImpact } from './scoring'
import type { ThemeImpact } from './scoring'
import type { SynergyTag } from './synergy/tagger'

export interface BuySuggestion {
  oracleId: string
  name: string
  tag: string
  weight: number
  priceEur: number | null
  cmc: number
  confidence: number
  themeImpact: ThemeImpact
  scryfallUrl: string
  reason: string
}

export interface BuyResult {
  needs: DeckNeed[]
  buys: BuySuggestion[]
}

/** A Scryfall exact-name search link — the brief uses Scryfall for card info/pricing. */
export function buildScryfallUrl(name: string): string {
  return `https://scryfall.com/search?q=${encodeURIComponent(`!"${name}"`)}`
}

export async function suggestBuys(
  supabase: SupabaseClient,
  userId: string,
  deckId: string,
  budget: number | null,
): Promise<{ result?: BuyResult; error?: string }> {
  const { found, deckIdentity, scoreCards, targetOverrides, cardLocks } = await loadDeckForScoring(supabase, deckId)
  if (!found) return { error: 'Deck not found.' }
  const excluded = new Set(cardLocks?.excluded ?? [])

  const power = computePowerScore(scoreCards, targetOverrides)
  // Lands are bought differently (mana base) — keep buy suggestions to spell roles.
  const needTags = power.needs.map((n) => n.tag).filter((t) => t !== 'land')
  if (needTags.length === 0) return { result: { needs: power.needs, buys: [] } }

  const ctx = buildDeckContext(scoreCards, power.avgMv)
  const needByTag = new Map(power.needs.map((n) => [n.tag as string, n]))

  const { data, error } = await supabase.rpc('co_buy_candidates', {
    p_user_id: userId,
    p_deck_id: deckId,
    p_identity: deckIdentity,
    p_need_tags: needTags,
    p_max_price: budget,
    p_limit: 200,
  })
  if (error) return { error: `Buy lookup failed: ${error.message}` }

  const all: BuySuggestion[] = (data ?? [])
    .filter((r: Record<string, unknown>) => !excluded.has(String(r.oracle_id)))
    .map((r: Record<string, unknown>) => {
    const priceEur = r.price_eur != null ? Number(r.price_eur) : null
    const tag = String(r.tag) as SynergyTag
    const weight = Number(r.weight)
    // Only the candidate's single best tag is known from SQL, so synergy/theme are an
    // approximation — still enough to prefer on-theme purchases over generic staples.
    const candTags = [{ tag, weight }]
    const need = needByTag.get(tag)
    const impact = themeImpact(candTags, ctx.themeTags)
    const conf = confidence({
      needGap: need?.gap ?? 1,
      target: need?.target ?? 10,
      roleWeight: weight,
      replacementDelta: weight,
      commanderSynergy: commanderSynergy(candTags, ctx.commanderTags),
      themeImpact: impact,
      curveFit: curveFit(Number(r.cmc) || 0, ctx.avgMv),
      availability: 'buy',
      hasCommander: ctx.hasCommander,
    })
    return {
      oracleId: String(r.oracle_id),
      name: String(r.name),
      tag,
      weight,
      priceEur,
      cmc: Number(r.cmc) || 0,
      confidence: conf,
      themeImpact: impact,
      scryfallUrl: buildScryfallUrl(String(r.name)),
      reason:
        `Fills ${tag.replace(/_/g, ' ')}` +
        (impact === 'Keeps Theme' ? ', on-theme' : impact === 'Weakens Theme' ? ', off-theme' : '') +
        (priceEur != null ? ` · €${priceEur.toFixed(2)}` : ''),
    }
  })

  // Best-fit first within each role, then round-robin across roles for coverage.
  all.sort((a, b) => b.confidence - a.confidence)
  return { result: { needs: power.needs, buys: diversify(all, PER_TAG, BUY_TOTAL) } }
}

const PER_TAG = 8
const BUY_TOTAL = 30

// Round-robin across the needed roles so the strongest of EACH need shows near the
// top, instead of one high-weight role (e.g. cheap card draw) crowding out the rest.
function diversify(all: BuySuggestion[], perTag: number, total: number): BuySuggestion[] {
  const byTag = new Map<string, BuySuggestion[]>()
  for (const b of all) {
    const list = byTag.get(b.tag) ?? []
    if (list.length < perTag) list.push(b) // `all` is confidence-sorted, so per tag we keep the best fits
    byTag.set(b.tag, list)
  }
  const lists = [...byTag.values()]
  const out: BuySuggestion[] = []
  for (let i = 0; i < perTag && out.length < total; i += 1) {
    for (const list of lists) {
      if (list[i]) out.push(list[i])
      if (out.length >= total) break
    }
  }
  return out
}
