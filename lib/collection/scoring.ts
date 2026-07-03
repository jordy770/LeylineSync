// Recommendation scoring — the "thinks like a Commander player" layer that sits on
// top of the role/colour/legality filtering. All pure + deterministic so the numbers
// are reproducible and auditable; the AI only explains these signals, never invents.
//
// Signals, in order of how much they make a suggestion "feel right":
//   * commander synergy — does the card do what the commander cares about?
//   * theme preservation — does it reinforce the deck's archetype (or fight it)?
//   * role need + strength — does the deck lack this role, and is the card good at it?
//   * replacement delta — how much better than the card it would replace?
//   * curve fit + availability — cheap/owned beats clunky/buy.

import type { DeckCardForScore } from './power-score'
import type { CardTag, SynergyTag } from './synergy/tagger'

// Roles every Commander deck wants — these define NEEDS, not a theme. A deck isn't
// "a removal deck"; it's e.g. "a sacrifice deck that also needs removal".
export const STAPLE_TAGS: ReadonlySet<SynergyTag> = new Set([
  'ramp',
  'card_draw',
  'removal',
  'board_wipe',
  'tutor',
  'protection',
  'land',
])

export type ThemeImpact = 'Keeps Theme' | 'Neutral' | 'Weakens Theme'

export interface DeckContext {
  commanderTags: CardTag[]
  hasCommander: boolean
  themeTags: Set<SynergyTag>
  avgMv: number
}

/** The deck's archetype tags — non-staple roles that appear on enough cards to be a
 *  deliberate theme (default ≥6 cards), not incidental. */
export function deckThemeTags(cards: DeckCardForScore[], threshold = 6): Set<SynergyTag> {
  const counts = new Map<SynergyTag, number>()
  for (const c of cards) {
    for (const { tag } of c.tags) {
      if (STAPLE_TAGS.has(tag)) continue
      counts.set(tag, (counts.get(tag) ?? 0) + c.quantity)
    }
  }
  const set = new Set<SynergyTag>()
  for (const [tag, n] of counts) if (n >= threshold) set.add(tag)
  return set
}

/** The commander's own tags — a proxy for what the commander rewards. */
export function commanderTagsOf(cards: DeckCardForScore[]): CardTag[] {
  return cards.find((c) => c.isCommander)?.tags ?? []
}

/** Build the per-deck scoring context once, to pass into the builders. */
export function buildDeckContext(cards: DeckCardForScore[], avgMv: number): DeckContext {
  const commanderTags = commanderTagsOf(cards)
  return { commanderTags, hasCommander: commanderTags.length > 0, themeTags: deckThemeTags(cards), avgMv }
}

/** 0–1: how strongly the candidate overlaps the commander's rewarded roles. */
export function commanderSynergy(candidateTags: CardTag[], commanderTags: CardTag[]): number {
  if (commanderTags.length === 0) return 0
  const cand = new Set(candidateTags.map((t) => t.tag))
  let matched = 0
  let total = 0
  for (const ct of commanderTags) {
    total += ct.weight
    if (cand.has(ct.tag)) matched += ct.weight
  }
  return total > 0 ? clamp01(matched / total) : 0
}

/** Keeps / Neutral / Weakens, from theme-tag overlap. A pure staple is Neutral (it
 *  doesn't fight the theme); a card carrying an off-theme archetype tag Weakens it. */
export function themeImpact(candidateTags: CardTag[], themeTags: Set<SynergyTag>): ThemeImpact {
  if (themeTags.size === 0) return 'Neutral'
  const tags = candidateTags.map((t) => t.tag)
  if (tags.some((t) => themeTags.has(t))) return 'Keeps Theme'
  const offThemeArchetype = tags.some((t) => !STAPLE_TAGS.has(t))
  return offThemeArchetype ? 'Weakens Theme' : 'Neutral'
}

/** 0–1: cards at or below the deck's average MV help the curve; clunky cards hurt. */
export function curveFit(cmc: number, avgMv: number): number {
  if (avgMv <= 0) return 0.5
  if (cmc <= avgMv) return 1
  return clamp01(1 - (cmc - avgMv) / 4)
}

export interface ConfidenceSignals {
  needGap: number
  target: number
  roleWeight: number
  replacementDelta: number
  commanderSynergy: number
  themeImpact: ThemeImpact
  curveFit: number
  availability: 'free' | 'occupied' | 'buy'
  hasCommander: boolean
}

const WEIGHTS = { need: 0.2, role: 0.17, delta: 0.13, commander: 0.22, theme: 0.14, curve: 0.07, availability: 0.07 }

/** 0–100 composite. When the deck has no parsed commander, the commander term is
 *  dropped and the rest is renormalised (so confidence isn't artificially capped). */
export function confidence(s: ConfidenceSignals): number {
  const themeScore = s.themeImpact === 'Keeps Theme' ? 1 : s.themeImpact === 'Weakens Theme' ? 0.25 : 0.6
  const availScore = s.availability === 'free' ? 1 : s.availability === 'occupied' ? 0.7 : 0.45

  const terms: [number, number][] = [
    [WEIGHTS.need, clamp01(s.needGap / Math.max(1, s.target))],
    [WEIGHTS.role, clamp01(s.roleWeight / 4)],
    [WEIGHTS.delta, clamp01(s.replacementDelta / 3)],
    [WEIGHTS.theme, themeScore],
    [WEIGHTS.curve, clamp01(s.curveFit)],
    [WEIGHTS.availability, availScore],
  ]
  let num = 0
  let den = 0
  for (const [w, v] of terms) {
    num += w * v
    den += w
  }
  if (s.hasCommander) {
    num += WEIGHTS.commander * s.commanderSynergy
    den += WEIGHTS.commander
  }
  return Math.round(clamp01(num / den) * 100)
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}
