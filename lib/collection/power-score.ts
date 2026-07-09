// Power score — a transparent, deterministic 0–10 rating of a Commander deck from
// its synergy buckets and curve. Deliberately explainable (fixed targets + weights)
// so the number is reproducible and the breakdown is auditable. The AI explanation
// layer (later) sits on top of this; it does not replace the math.

import { STAPLE_TAGS } from './scoring'
import type { SynergyTag } from './synergy/tagger'

export interface DeckCardForScore {
  oracleId: string
  quantity: number
  cmc: number
  typeLine: string
  isCommander: boolean
  tags: { tag: SynergyTag; weight: number }[]
}

export interface DeckNeed {
  tag: SynergyTag
  have: number
  target: number
  gap: number
}

export interface HealthAxis {
  axis: string
  score: number // 0-100
  explanation: string
}

export interface PowerScore {
  power: number
  buckets: Record<string, number>
  curve: Record<string, number>
  avgMv: number
  landCount: number
  nonlandCount: number
  needs: DeckNeed[]
  health: HealthAxis[]
  explanation: string
}

// Classic Commander deck-building guidelines (per ~99-card deck). These are
// the DEFAULTS — a deck can override any of the tunable tags (mig 384), which
// shifts needs, the scanner, the Advisor and the Doctor along with it.
export const DEFAULT_TARGETS: Partial<Record<SynergyTag, number>> = {
  land: 37,
  ramp: 10,
  card_draw: 10,
  removal: 8,
  board_wipe: 3,
}

/** Tags a player may set a per-deck target for. counterspell/tutor have no
 *  default target — overriding them ADDS a need the guidelines don't track. */
export const TUNABLE_TAGS = ['land', 'ramp', 'card_draw', 'removal', 'board_wipe', 'counterspell', 'tutor'] as const
export type TunableTag = (typeof TUNABLE_TAGS)[number]
/** Tag targets plus `curve` (desired average mana value, default 3) and
 *  `bracket` (the deck's target Commander Bracket, 1-5 — used by the scanner
 *  and Doctor to respect the Game Changers allowance, not by the score). */
export type TargetOverrides = Partial<Record<TunableTag, number>> & { curve?: number; bracket?: number }

export const DEFAULT_CURVE_TARGET = 3

/** Pure: keep only known tags with sane integer values (0..60), plus a curve
 *  target (avg MV, 1..8, one decimal). Returns null when nothing survives. */
export function sanitizeTargetOverrides(input: unknown): TargetOverrides | null {
  if (input == null || typeof input !== 'object') return null
  const out: TargetOverrides = {}
  for (const tag of TUNABLE_TAGS) {
    const v = (input as Record<string, unknown>)[tag]
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[tag] = Math.max(0, Math.min(60, Math.round(v)))
    }
  }
  const curve = (input as Record<string, unknown>).curve
  if (typeof curve === 'number' && Number.isFinite(curve)) {
    out.curve = Math.max(1, Math.min(8, Math.round(curve * 10) / 10))
  }
  const bracket = (input as Record<string, unknown>).bracket
  if (typeof bracket === 'number' && Number.isFinite(bracket)) {
    out.bracket = Math.max(1, Math.min(5, Math.round(bracket)))
  }
  return Object.keys(out).length > 0 ? out : null
}

// How much each component pulls the 0–1 score before scaling to 10.
const WEIGHTS = {
  land: 0.15,
  ramp: 0.2,
  card_draw: 0.2,
  removal: 0.2,
  board_wipe: 0.1,
  curve: 0.15,
}

// Buckets surfaced in the analysis UI (counts of quantity-weighted sources).
const BUCKET_TAGS: SynergyTag[] = [
  'ramp',
  'card_draw',
  'removal',
  'board_wipe',
  'counterspell',
  'tutor',
  'recursion',
  'protection',
  'win_condition',
]

export function computePowerScore(cards: DeckCardForScore[], overrides?: TargetOverrides | null): PowerScore {
  // Effective targets: guidelines + the deck's own tuning (mig 384). `curve`
  // and `bracket` are not tag targets — split them off before spreading into
  // the needs map (bracket doesn't touch the score at all).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- bracket is split off, not scored
  const { curve: curveTargetRaw, bracket: _bracket, ...tagOverrides } = overrides ?? {}
  const curveTarget = curveTargetRaw ?? DEFAULT_CURVE_TARGET
  const targets: Partial<Record<SynergyTag, number>> = { ...DEFAULT_TARGETS, ...tagOverrides }
  const isLand = (c: DeckCardForScore) => c.tags.some((t) => t.tag === 'land') || /\bland\b/i.test(c.typeLine)

  let landCount = 0
  let nonlandCount = 0
  let cmcSum = 0
  const curve: Record<string, number> = {}
  const bucketCounts = new Map<SynergyTag, number>()

  for (const c of cards) {
    const qty = c.quantity
    if (isLand(c)) {
      landCount += qty
    } else {
      nonlandCount += qty
      cmcSum += c.cmc * qty
      const slot = c.cmc >= 7 ? '7+' : String(Math.floor(c.cmc))
      curve[slot] = (curve[slot] ?? 0) + qty
    }
    for (const { tag } of c.tags) {
      bucketCounts.set(tag, (bucketCounts.get(tag) ?? 0) + qty)
    }
  }

  const avgMv = nonlandCount > 0 ? round1(cmcSum / nonlandCount) : 0

  const buckets: Record<string, number> = {}
  for (const tag of BUCKET_TAGS) buckets[tag] = bucketCounts.get(tag) ?? 0

  // Component coverage vs targets, each clamped to [0,1]. A target of 0 means
  // "this deck doesn't want these" — full coverage by definition.
  const coverage = (tag: SynergyTag) => {
    const target = targets[tag] ?? 0
    if (target <= 0) return 1
    const have = tag === 'land' ? landCount : bucketCounts.get(tag) ?? 0
    return Math.min(1, have / target)
  }
  // Curve: reward an average mana value around the deck's target (default 3);
  // fall off above it. A tuned high-curve deck stops being punished for it.
  const curveScore = nonlandCount === 0 ? 0 : clamp01(1 - Math.max(0, avgMv - curveTarget) / 3)

  const score01 =
    WEIGHTS.land * coverage('land') +
    WEIGHTS.ramp * coverage('ramp') +
    WEIGHTS.card_draw * coverage('card_draw') +
    WEIGHTS.removal * coverage('removal') +
    WEIGHTS.board_wipe * coverage('board_wipe') +
    WEIGHTS.curve * curveScore

  const power = round1(clamp(score01 * 10, 0, 10))

  const needs: DeckNeed[] = (Object.keys(targets) as SynergyTag[])
    .map((tag) => {
      const target = targets[tag] ?? 0
      const have = tag === 'land' ? landCount : bucketCounts.get(tag) ?? 0
      return { tag, have, target, gap: Math.max(0, target - have) }
    })
    .filter((n) => n.gap > 0)
    .sort((a, b) => b.gap - a.gap)

  const health = computeHealth(bucketCounts, landCount, nonlandCount, avgMv, curveScore, cards, targets)

  return {
    power,
    buckets,
    curve,
    avgMv,
    landCount,
    nonlandCount,
    needs,
    health,
    explanation: explain(power, buckets, landCount, avgMv, needs),
  }
}

// Per-axis deck health (0-100) — a richer read than the single power number, each
// with a plain-language "why". Derived from the same buckets, so it stays consistent.
function computeHealth(
  bucket: Map<SynergyTag, number>,
  landCount: number,
  nonlandCount: number,
  avgMv: number,
  curveScore: number,
  cards: DeckCardForScore[],
  targets: Partial<Record<SynergyTag, number>>,
): HealthAxis[] {
  const b = (t: SynergyTag) => bucket.get(t) ?? 0
  const pct = (have: number, target: number) => (target <= 0 ? 100 : Math.round(clamp01(have / target) * 100))
  const tLand = targets.land ?? 37
  const tRamp = targets.ramp ?? 10
  const tDraw = targets.card_draw ?? 10
  const tInteraction = (targets.removal ?? 8) + (targets.counterspell ?? 2)

  const ramp = b('ramp')
  const draw = b('card_draw')
  const removal = b('removal')
  const counter = b('counterspell')
  const tutor = b('tutor')
  const wincon = b('win_condition')

  // Dominant non-staple (archetype) tag = the deck's theme.
  const themeCounts = new Map<SynergyTag, number>()
  for (const c of cards) {
    for (const { tag } of c.tags) {
      if (STAPLE_TAGS.has(tag)) continue
      themeCounts.set(tag, (themeCounts.get(tag) ?? 0) + c.quantity)
    }
  }
  let topTheme: SynergyTag | null = null
  let topN = 0
  for (const [tag, count] of themeCounts) {
    if (count > topN) {
      topN = count
      topTheme = tag
    }
  }
  const themeScore = nonlandCount > 0 ? Math.round(clamp01(topN / Math.max(8, nonlandCount * 0.25)) * 100) : 0

  const consistency = Math.round(
    clamp01(Math.min(1, tutor / 4) * 0.35 + Math.min(1, draw / 10) * 0.35 + curveScore * 0.3) * 100,
  )

  return [
    { axis: 'Mana Base', score: pct(landCount, tLand), explanation: `${landCount}/${tLand} lands.` },
    { axis: 'Ramp', score: pct(ramp, tRamp), explanation: `${ramp} ramp sources (target ~${tRamp}).` },
    { axis: 'Draw', score: pct(draw, tDraw), explanation: `${draw} card-draw sources (target ~${tDraw}).` },
    {
      axis: 'Interaction',
      score: pct(removal + counter, tInteraction),
      explanation: `${removal} removal + ${counter} counterspells (target ~${tInteraction}).`,
    },
    {
      axis: 'Win Conditions',
      score: pct(wincon, 2),
      explanation: wincon > 0 ? `${wincon} explicit finishers tagged.` : 'No tagged finishers — your win plan is likely combat/value.',
    },
    {
      axis: 'Consistency',
      score: consistency,
      explanation: `${tutor} tutors, ${draw} draw, avg MV ${avgMv} — how reliably you assemble your game plan.`,
    },
    {
      axis: 'Theme',
      score: themeScore,
      explanation: topTheme ? `Built around ${label(topTheme)} (${topN} cards).` : 'No dominant theme — a goodstuff deck.',
    },
  ]
}

function explain(power: number, buckets: Record<string, number>, landCount: number, avgMv: number, needs: DeckNeed[]): string {
  const strengths: string[] = []
  if (buckets.ramp >= 10) strengths.push(`ramp (${buckets.ramp})`)
  if (buckets.card_draw >= 10) strengths.push(`card draw (${buckets.card_draw})`)
  if (buckets.removal >= 8) strengths.push(`removal (${buckets.removal})`)
  if (buckets.board_wipe >= 3) strengths.push(`board wipes (${buckets.board_wipe})`)

  const lines = [`Power ${power}/10 — ${landCount} lands, avg MV ${avgMv}.`]
  if (strengths.length) lines.push(`Strengths: ${strengths.join(', ')}.`)
  if (needs.length) {
    lines.push(
      `Below guideline: ${needs.map((n) => `${label(n.tag)} ${n.have}/${n.target} (need ${n.gap} more)`).join(', ')}.`,
    )
  } else {
    lines.push('Meets the core ramp / draw / removal / wipe / land guidelines.')
  }
  return lines.join(' ')
}

function label(tag: SynergyTag): string {
  return tag.replace(/_/g, ' ')
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}
function clamp01(n: number): number {
  return clamp(n, 0, 1)
}
