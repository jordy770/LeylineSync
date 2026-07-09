// Trade package builder — "I want X; build a fair offer from my spare cards."
// Grounding: the model only sees (and may only pick from) the player's FREE
// binder cards with OUR prices; the total is recomputed from those prices, so
// the fairness math can't be hallucinated.

import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'

import { askClaudeJson, requireApiKey } from './ai-client'
import { loadAvailability, loadOracleMeta } from './deck-loader'

const TRADABLE_CAP = 150
const MIN_PRICE_EUR = 0.25

const ReplySchema = z.object({
  rationale: z.string(),
  package: z.array(z.string()).min(1),
  alternates: z.array(z.string()).optional(),
})

export interface TradeCard {
  name: string
  priceEur: number
}

export interface TradeResult {
  rationale: string
  cards: TradeCard[]
  totalEur: number
  alternates: TradeCard[]
}

/** Pure: keep only offered cards that are really in the tradable list, and
 *  recompute the package total from OUR prices. */
export function groundTradePackage(names: string[], tradables: TradeCard[]): { cards: TradeCard[]; totalEur: number } {
  const byName = new Map(tradables.map((t) => [t.name.toLowerCase(), t]))
  const seen = new Set<string>()
  const cards: TradeCard[] = []
  for (const raw of names) {
    const t = byName.get(raw.trim().toLowerCase())
    if (!t || seen.has(t.name)) continue
    seen.add(t.name)
    cards.push(t)
  }
  const totalEur = Math.round(cards.reduce((sum, c) => sum + c.priceEur, 0) * 100) / 100
  return { cards, totalEur }
}

const SYSTEM = `You are a Magic: The Gathering trade negotiator helping a player assemble a FAIR trade package from their spare cards.
You get: what the player wants ("want", free text — may include the card name and a rough value), an optional explicit target value in EUR, and "tradables" — the player's spare cards with market prices in EUR.
Build a package whose total comes close to the target value (within ~10% — slightly above is friendlier than below). Prefer FEWER, bigger cards over piles of bulk; avoid offering cards that are obviously deck-staples someone would rather keep (fetch lands, format staples) unless the value demands it. If "want" names a card without a value and no target is given, estimate the card's market value yourself and aim for that.
Also list 2-4 "alternates" — swap-in options at similar value in case the other player doesn't want a piece.
Every card in "package" and "alternates" MUST appear verbatim in tradables.
"rationale": 2-3 sentences — why this package is fair and how to pitch it.
Respond with ONLY a JSON object: {"rationale": string, "package": [string], "alternates": [string]}. No prose, no code fences.`

export async function buildTradePackage(
  supabase: SupabaseClient,
  userId: string,
  options: { want: string; targetValueEur?: number | null; apiKey?: string },
): Promise<{ result?: TradeResult; error?: string }> {
  const apiKey = requireApiKey(options.apiKey)
  const want = options.want.trim().slice(0, 200)
  if (!want) return { error: 'Say what you want to trade for.' }

  const avail = await loadAvailability(supabase, userId)
  const freeIds = avail.filter((a) => a.freeQty > 0).map((a) => a.oracleId)
  const meta = await loadOracleMeta(supabase, freeIds)
  const tradables: TradeCard[] = freeIds
    .flatMap((id) => {
      const m = meta.get(id)
      if (!m || m.priceEur == null || m.priceEur < MIN_PRICE_EUR) return []
      if (/basic land/i.test(m.typeLine)) return []
      return [{ name: m.name, priceEur: m.priceEur }]
    })
    .sort((a, b) => b.priceEur - a.priceEur)
    .slice(0, TRADABLE_CAP)

  if (tradables.length === 0) {
    return { error: 'No tradable cards found — your free binder has no priced cards above €0.25.' }
  }

  const context = { want, targetValueEur: options.targetValueEur ?? null, tradables }
  const raw = await askClaudeJson(apiKey, SYSTEM, context, ReplySchema, 1200)

  const pkg = groundTradePackage(raw.package, tradables)
  const alternates = groundTradePackage(raw.alternates ?? [], tradables)
  if (pkg.cards.length === 0) return { error: 'The AI could not assemble a package from your tradable cards.' }

  return { result: { rationale: raw.rationale, cards: pkg.cards, totalEur: pkg.totalEur, alternates: alternates.cards } }
}
