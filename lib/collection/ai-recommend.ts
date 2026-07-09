// AI deck-doctor — a reasoning layer ON TOP of the deterministic scan. The model
// never retrieves or invents cards: it only ranks/explains candidates the scanner
// already produced (color-legal, owned), and any pick it returns that isn't in that
// list is dropped. This keeps legality/price/ownership truthful and the output
// grounded. Theme preservation is delegated to the model via the commander name.

import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'

import { askClaudeJson, requireApiKey } from './ai-client'
import { suggestBuys } from './buy-suggestions'
import { loadAvailability, loadOracleMeta, loadTags, sanitizeCardLocks } from './deck-loader'
import { scanDeckUpgrades } from './upgrade-scanner'
import type { UpgradeScanResult } from './upgrade-scanner'

export { AiNotConfiguredError } from './ai-client'

const OWNED_CAP = 16 // free + occupied candidates shown to the model
const BUY_CAP = 10 // purchase candidates shown to the model
const GOAL_POOL_CAP = 100 // wider binder pool shown when the player states a goal
const GOAL_MAX_LENGTH = 300

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

export interface GoalPoolEntry {
  oracleId: string
  name: string
  typeLine: string
  colorIdentity: string[]
  priceEur: number | null
  tags: { tag: string; weight: number }[]
}

/** Pure: the wider binder pool for goal mode — color-legal free cards the
 *  scanner didn't already surface, strongest role first. Basic lands and
 *  untagged chaff rank last, and the pool is capped so the prompt stays sane. */
export function buildGoalPool(
  entries: GoalPoolEntry[],
  deckIdentity: string[],
  exclude: Set<string>,
  cap = GOAL_POOL_CAP,
  direction: 'strong' | 'weak' = 'strong',
): RecommendCandidate[] {
  const pool = entries
    .filter((e) => !exclude.has(e.oracleId))
    .filter((e) => !/basic land/i.test(e.typeLine))
    .filter((e) => e.colorIdentity.every((c) => deckIdentity.includes(c)))
    .map((e) => {
      const best = e.tags.reduce<{ tag: string; weight: number } | null>(
        (a, b) => (b.weight > (a?.weight ?? 0) ? b : a),
        null,
      )
      return {
        oracleId: e.oracleId,
        name: e.name,
        tag: best?.tag ?? 'untagged',
        weight: best?.weight ?? 0,
        priceEur: e.priceEur,
        source: 'free' as const,
        confidence: 0, // no engine score — the model judges these on the goal
        themeImpact: 'Neutral',
        replaces: null,
      }
    })
  // Down-tuning wants the WEAK cards first — that's what you swap in to hit a
  // lower power target without leaving the theme.
  pool.sort((a, b) =>
    direction === 'weak'
      ? a.weight - b.weight || (a.priceEur ?? 0) - (b.priceEur ?? 0)
      : b.weight - a.weight || (b.priceEur ?? 0) - (a.priceEur ?? 0),
  )
  return pool.slice(0, cap)
}

export async function recommendDeckUpgrades(
  supabase: SupabaseClient,
  userId: string,
  deckId: string,
  options: { budget?: number | null; apiKey?: string; goal?: string | null; targetPower?: number | null },
): Promise<{ result?: RecommendResult; error?: string }> {
  const apiKey = requireApiKey(options.apiKey)

  const budget = options.budget ?? null
  const goal = (options.goal ?? '').trim().slice(0, GOAL_MAX_LENGTH) || null
  const targetPower =
    options.targetPower != null && options.targetPower >= 1 && options.targetPower <= 10
      ? Math.round(options.targetPower * 10) / 10
      : null

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

  const { data: deck } = await supabase
    .from('co_decks')
    .select('commander_oracle_id, color_identity, card_locks')
    .eq('id', deckId)
    .maybeSingle()
  const deckIdentity = (deck?.color_identity as string[]) ?? []
  const cardLocks = sanitizeCardLocks(deck?.card_locks)
  let commander: string | null = null
  if (deck?.commander_oracle_id) {
    commander = (await loadOracleMeta(supabase, [deck.commander_oracle_id as string])).get(deck.commander_oracle_id as string)?.name ?? null
  }

  // Playgroup meta (mig 383): free text about what the pod plays, injected into
  // every run so the advice is tuned to the actual tables this deck faces.
  const { data: metaRow } = await supabase.from('co_player_meta').select('meta').eq('user_id', userId).maybeSingle()
  const playgroupMeta = ((metaRow?.meta as string) ?? '').trim().slice(0, 400) || null

  const detuning = targetPower != null && targetPower < scan.result.power.power

  // Goal or power-target mode: the need-based candidates are not enough —
  // widen the pool to the whole color-legal free binder (capped) so the model
  // can chase the direction through owned cards FIRST, buys last. Down-tuning
  // flips the ranking: the weak cards are the swap-ins.
  let goalPool: RecommendCandidate[] = []
  if (goal || targetPower != null) {
    const avail = await loadAvailability(supabase, userId)
    const freeIds = avail.filter((a) => a.freeQty > 0).map((a) => a.oracleId)
    const [poolMeta, poolTags] = await Promise.all([loadOracleMeta(supabase, freeIds), loadTags(supabase, freeIds)])
    const exclude = new Set<string>([
      ...scan.result.deckList.map((c) => c.oracleId),
      ...owned.map((c) => c.oracleId),
      ...buyCandidates.map((c) => c.oracleId),
      ...(cardLocks?.excluded ?? []), // dismissed for this deck — never resuggest
    ])
    goalPool = buildGoalPool(
      freeIds.flatMap((id) => {
        const m = poolMeta.get(id)
        return m
          ? [{ oracleId: id, name: m.name, typeLine: m.typeLine, colorIdentity: m.colorIdentity, priceEur: m.priceEur, tags: poolTags.get(id) ?? [] }]
          : []
      }),
      deckIdentity,
      exclude,
      GOAL_POOL_CAP,
      detuning ? 'weak' : 'strong',
    )
  }

  const candidates = [...owned, ...buyCandidates, ...goalPool]

  if (candidates.length === 0) {
    return { result: { summary: 'No candidate upgrades to evaluate — your deck already covers its needs from the binder, or none fit the budget.', picks: [] } }
  }

  const context = {
    commander,
    colorIdentity: deckIdentity,
    playerGoal: goal,
    playgroupMeta,
    targetPower,
    // The deck's own list, so goal/power advice can name concrete cuts.
    deckCards: goal || targetPower != null ? scan.result.deckList.map((c) => c.name) : undefined,
    // Pet cards — the model may never propose cutting these.
    lockedCards:
      cardLocks && cardLocks.locked.length > 0
        ? scan.result.deckList.filter((c) => cardLocks.locked.includes(c.oracleId)).map((c) => c.name)
        : undefined,
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

  const raw = await askClaudeJson(apiKey, SYSTEM, context, ReplySchema, 2500)
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
Goal mode: when the context has a non-null "playerGoal", it states what the player WANTS this deck to become — judge every candidate primarily on how much it advances that goal (the computed "needs" become secondary), and say in the summary how far the goal can be reached from owned cards alone. In goal mode the list also contains candidates with "confidence": 0 — those come from the player's wider binder without an engine score; evaluate them yourself from the card name and its role. The ownership priority is absolute in goal mode: exhaust "free" candidates that serve the goal before recommending any "buy". Do not restate weak goal-fits as includes just to fill space — a short, on-goal plan beats a long padded one.
Playgroup meta: when "playgroupMeta" is non-null it describes what the player's pod actually plays. Weigh candidates against that meta (e.g. graveyard-heavy pod → grave hate rises; treasure decks → artifact interaction rises) and reference the meta in reasons where it drives a verdict.
Locked cards: "lockedCards" (when present) lists pet cards the player protects — NEVER propose cutting one, not even in a reason; work around them.
Power tuning: when "targetPower" is non-null the player wants the deck AT that power level (0-10 scale; "power" is the current level). If the target is BELOW the current power, propose DOWN-tunes: for each include, name a stronger card from "deckCards" to cut in the reason ("swap in X for Y"), keep the deck's theme intact, and never call a downgrade an upgrade — be honest that it weakens the deck on purpose. If the target is above, tune upward as usual. "deckCards" is the deck's own list, for naming cuts only — never recommend a deckCards entry as a pick.
Respond with ONLY a JSON object: {"summary": string, "picks": [{"name": string, "verdict": "include"|"consider"|"skip", "reason": string}]}. No prose, no code fences.`

