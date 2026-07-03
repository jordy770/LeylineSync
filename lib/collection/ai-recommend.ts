// AI deck-doctor — a reasoning layer ON TOP of the deterministic scan. The model
// never retrieves or invents cards: it only ranks/explains candidates the scanner
// already produced (color-legal, owned), and any pick it returns that isn't in that
// list is dropped. This keeps legality/price/ownership truthful and the output
// grounded. Theme preservation is delegated to the model via the commander name.

import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'

import { suggestBuys } from './buy-suggestions'
import { loadOracleMeta } from './deck-loader'
import { scanDeckUpgrades } from './upgrade-scanner'
import type { UpgradeScanResult } from './upgrade-scanner'

const MODEL = 'claude-opus-4-8'
const OWNED_CAP = 16 // free + occupied candidates shown to the model
const BUY_CAP = 10 // purchase candidates shown to the model

export type CandidateSource = 'free' | 'occupied' | 'buy'

export interface RecommendCandidate {
  oracleId: string
  name: string
  tag: string
  weight: number
  priceEur: number | null
  source: CandidateSource
  confidence: number
  themeImpact: string
  replaces: string | null
}

export interface RecommendPick {
  oracleId: string
  name: string
  tag: string
  source: CandidateSource
  priceEur: number | null
  confidence: number
  themeImpact: string
  verdict: 'include' | 'consider' | 'skip'
  reason: string
}

export interface RecommendResult {
  summary: string
  picks: RecommendPick[]
}

/** Flatten the scan's free + occupied upgrades into one candidate list (deduped). */
export function buildCandidateList(scan: UpgradeScanResult): RecommendCandidate[] {
  const byOracle = new Map<string, RecommendCandidate>()
  for (const f of scan.free) {
    if (!byOracle.has(f.in.oracleId)) {
      byOracle.set(f.in.oracleId, {
        oracleId: f.in.oracleId, name: f.in.name, tag: f.tag, weight: f.inWeight, priceEur: f.in.priceEur,
        source: 'free', confidence: f.confidence, themeImpact: f.themeImpact, replaces: f.out?.name ?? null,
      })
    }
  }
  for (const o of scan.occupied) {
    if (!byOracle.has(o.in.oracleId)) {
      byOracle.set(o.in.oracleId, {
        oracleId: o.in.oracleId, name: o.in.name, tag: o.tag, weight: o.weight, priceEur: o.in.priceEur,
        source: 'occupied', confidence: o.confidence, themeImpact: o.themeImpact, replaces: null,
      })
    }
  }
  return [...byOracle.values()]
}

const PickSchema = z.object({
  name: z.string(),
  verdict: z.enum(['include', 'consider', 'skip']),
  reason: z.string(),
})
const ReplySchema = z.object({ summary: z.string(), picks: z.array(PickSchema) })

/** Drop any pick whose name isn't an actual candidate, and re-attach truthful data. */
export function validatePicks(
  rawPicks: { name: string; verdict: 'include' | 'consider' | 'skip'; reason: string }[],
  candidates: RecommendCandidate[],
): RecommendPick[] {
  const byName = new Map(candidates.map((c) => [c.name.toLowerCase(), c]))
  const out: RecommendPick[] = []
  for (const p of rawPicks) {
    const c = byName.get(p.name.trim().toLowerCase())
    if (!c) continue // hallucinated / off-list — discard
    out.push({
      oracleId: c.oracleId, name: c.name, tag: c.tag, source: c.source, priceEur: c.priceEur,
      confidence: c.confidence, themeImpact: c.themeImpact, verdict: p.verdict, reason: p.reason,
    })
  }
  return out
}

export class AiNotConfiguredError extends Error {}

export async function recommendDeckUpgrades(
  supabase: SupabaseClient,
  userId: string,
  deckId: string,
  options: { budget?: number | null; apiKey?: string },
): Promise<{ result?: RecommendResult; error?: string }> {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new AiNotConfiguredError('AI is not configured. Set ANTHROPIC_API_KEY on the server.')

  const budget = options.budget ?? null

  const scan = await scanDeckUpgrades(supabase, userId, deckId)
  if (scan.error || !scan.result) return { error: scan.error ?? 'Could not analyse this deck.' }

  // Owned candidates (free + occupied) — never budget-filtered, you already have them.
  // Ranked by the engine's holistic confidence (commander + theme + role), not raw weight.
  const owned = buildCandidateList(scan.result)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, OWNED_CAP)

  // Buy candidates (not owned, within budget) so the doctor can also recommend purchases.
  const seen = new Set(owned.map((c) => c.oracleId))
  const buy = await suggestBuys(supabase, userId, deckId, budget)
  const buyCandidates: RecommendCandidate[] = (buy.result?.buys ?? [])
    .filter((b) => !seen.has(b.oracleId))
    .slice(0, BUY_CAP)
    .map((b) => ({
      oracleId: b.oracleId, name: b.name, tag: b.tag, weight: b.weight, priceEur: b.priceEur,
      source: 'buy' as const, confidence: b.confidence, themeImpact: b.themeImpact, replaces: null,
    }))

  const candidates = [...owned, ...buyCandidates]

  if (candidates.length === 0) {
    return { result: { summary: 'No candidate upgrades to evaluate — your deck already covers its needs from the binder, or none fit the budget.', picks: [] } }
  }

  const { data: deck } = await supabase.from('co_decks').select('commander_oracle_id, color_identity').eq('id', deckId).maybeSingle()
  let commander: string | null = null
  if (deck?.commander_oracle_id) {
    commander = (await loadOracleMeta(supabase, [deck.commander_oracle_id as string])).get(deck.commander_oracle_id as string)?.name ?? null
  }

  const context = {
    commander,
    colorIdentity: (deck?.color_identity as string[]) ?? [],
    power: scan.result.power.power,
    deckTheme: scan.result.power.health.find((h) => h.axis === 'Theme')?.explanation ?? null,
    buckets: scan.result.power.buckets,
    needs: scan.result.power.needs.map((n) => ({ tag: n.tag, have: n.have, target: n.target })),
    budgetEur: budget,
    // Each candidate carries the engine's pre-computed signals; the model REASONS over
    // them, it does not recompute or invent. `confidence` 0-100, `themeImpact` Keeps/
    // Neutral/Weakens, `replaces` = the in-deck card this would cut (free swaps only).
    candidates: candidates.map((c) => ({
      name: c.name,
      role: c.tag,
      strength: c.weight,
      priceEur: c.priceEur,
      source: c.source,
      confidence: c.confidence,
      themeImpact: c.themeImpact,
      replaces: c.replaces,
    })),
  }

  const raw = await callClaude(apiKey, context)
  return { result: { summary: raw.summary, picks: validatePicks(raw.picks, candidates) } }
}

const SYSTEM = `You are a Magic: The Gathering Commander deck doctor.
You are given a deck's power profile, its under-served needs, and a CLOSED LIST of candidate upgrade cards (each with a role, a strength 1-4, a price, and a "source").
The "source" tells you ownership:
- "free" = the player already owns it, free in their binder.
- "occupied" = the player owns it, but it's currently in another deck.
- "buy" = the player does NOT own it; recommending it means they'd have to purchase it.
Each candidate also has engine-computed signals — USE them, do not recompute or override them:
- "confidence" (0-100): the engine's overall fit score for THIS deck.
- "themeImpact": "Keeps Theme" / "Neutral" / "Weakens Theme".
- "replaces": the in-deck card this would cut (free swaps only) — compare IN vs OUT directly.
Rules:
- Recommend ONLY cards from the candidate list. Never invent or suggest cards not in the list.
- Follow the engine's PRIORITY: (1) keep the theme intact, (2) fix the biggest needs, (3) free binder cards, (4) cards in other decks, (5) only then buys. Prefer higher-confidence, Keeps-Theme candidates.
- A "Weakens Theme" card should be "consider" or "skip" even if objectively strong — say WHY it doesn't fit.
- Give CONCRETE, specific reasons, not generic praise. Reference the role gap, the commander's payoff, and — for swaps — why IN beats the named OUT card. Example of the right altitude: "Phyrexian Arena draws every upkeep with no board needed, so it out-values Curiosity, which only triggers when its enchanted creature connects."
- "include" = clear upgrade now; "consider" = situational / theme tension / optional buy; "skip" = on-list but not worth it.
Respond with ONLY a JSON object: {"summary": string, "picks": [{"name": string, "verdict": "include"|"consider"|"skip", "reason": string}]}. No prose, no code fences.`

async function callClaude(apiKey: string, context: unknown): Promise<z.infer<typeof ReplySchema>> {
  const client = new Anthropic({ apiKey })
  const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }]
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: JSON.stringify(context) }]

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await client.messages.create({ model: MODEL, max_tokens: 1600, system, messages })
    const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('')
    const parsed = extractJson(text)
    const validated = ReplySchema.safeParse(parsed)
    if (validated.success) return validated.data

    messages.push({ role: 'assistant', content: text })
    messages.push({ role: 'user', content: 'That was not the required JSON shape. Respond with only the JSON object {"summary","picks":[{"name","verdict","reason"}]}.' })
  }
  throw new Error('The AI could not produce a valid recommendation.')
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }
}
