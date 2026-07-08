// Deck analyzer — role-based deck composition + structured, explainable issues.
// PURE: takes classified cards, returns data. This is ADDITIVE next to the
// legacy power-score (whose six buckets remain the score contract); the roles
// view is richer (mana rocks vs dorks, draw engines vs one-shots, …) and every
// issue is a structured record a future AI layer can narrate — never compute.

import { classifyCard, type ClassifiedCard } from './card-engine'
import type { CardInput, Role } from './models'

export interface DeckCard extends CardInput {
  quantity: number
  isCommander?: boolean
}

export interface DeckIssue {
  /** Stable id, e.g. 'low-draw' — the future AI layer keys explanations off this. */
  id: string
  issue: string
  detail: string
  /** 0–1: how confident the heuristic is that this is a real problem. */
  confidence: number
  /** Roles that would fix it — feeds upgrade suggestions & conflict arbitration. */
  recommendedRoles: Role[]
}

export interface DeckIntelligence {
  cardCount: number
  landCount: number
  /** Lands + rocks + dorks + treasure makers — the real mana base. */
  manaSources: number
  avgManaValue: number
  roleCounts: { role: Role; count: number }[]
  issues: DeckIssue[]
  /** Per-card profiles, for callers that drill in (conflict arbiter, UI). */
  profiles: (ClassifiedCard & { quantity: number })[]
}

const count = (profiles: { profile: ClassifiedCard; quantity: number }[], roles: Role[]) =>
  profiles.reduce((n, p) => (p.profile.roles.some((r) => roles.includes(r.role)) ? n + p.quantity : n), 0)

export function analyzeDeckRoles(cards: DeckCard[]): DeckIntelligence {
  const entries = cards.map((card) => ({ profile: classifyCard(card), quantity: card.quantity, card }))

  const cardCount = cards.reduce((n, c) => n + c.quantity, 0)
  const landCount = entries.reduce(
    (n, e) => (/\bland\b/.test(e.card.typeLine.toLowerCase()) ? n + e.quantity : n), 0)
  const nonland = entries.filter((e) => !/\bland\b/.test(e.card.typeLine.toLowerCase()))
  const nonlandCount = nonland.reduce((n, e) => n + e.quantity, 0)
  const avgManaValue = nonlandCount === 0
    ? 0
    : Math.round((nonland.reduce((s, e) => s + e.card.cmc * e.quantity, 0) / nonlandCount) * 10) / 10

  const roleTotals = new Map<Role, number>()
  for (const e of entries) {
    for (const { role } of e.profile.roles) {
      roleTotals.set(role, (roleTotals.get(role) ?? 0) + e.quantity)
    }
  }

  const ramp = count(entries, ['ramp', 'mana_rock', 'mana_dork'])
  const manaSources = landCount + count(entries, ['mana_rock', 'mana_dork', 'treasure'])
  const draw = count(entries, ['card_draw', 'draw_engine', 'wheel'])
  const interaction = count(entries, ['spot_removal', 'counterspell'])
  const wipes = count(entries, ['board_wipe'])
  const wincons = count(entries, ['win_condition', 'combo_piece'])

  const issues: DeckIssue[] = []
  const issue = (id: string, text: string, detail: string, confidence: number, roles: Role[]) =>
    issues.push({ id, issue: text, detail, confidence, recommendedRoles: roles })

  if (draw < 8) {
    issue('low-draw', 'Low card draw', `${draw} draw effects — Commander decks want ~10.`,
      draw <= 4 ? 0.9 : 0.7, ['card_draw', 'draw_engine'])
  }
  if (ramp < 8) {
    issue('low-ramp', 'Light on ramp', `${ramp} mana accelerants — ~10 keeps a ${avgManaValue} curve on tempo.`,
      ramp <= 4 ? 0.9 : 0.65, ['ramp', 'mana_rock', 'mana_dork'])
  }
  if (interaction < 8) {
    issue('low-interaction', 'Low interaction', `${interaction} pieces of spot removal/counters — expect to face threats you must answer.`,
      interaction <= 4 ? 0.85 : 0.6, ['spot_removal', 'counterspell'])
  }
  if (wipes < 2) {
    issue('few-wipes', 'Few board wipes', `${wipes} mass-removal effects — one resolved battlecruiser turn can run away with the game.`,
      0.6, ['board_wipe'])
  }
  if (landCount > 0 && landCount < 33) {
    issue('few-lands', 'Low land count', `${landCount} lands — most 100-card decks want 35+ unless the curve is very low.`,
      landCount <= 30 ? 0.85 : 0.55, ['ramp'])
  }
  if (avgManaValue > 3.4 && ramp < 10) {
    issue('heavy-curve', 'Curve outruns the mana', `Average mana value ${avgManaValue} with only ${ramp} accelerants.`,
      0.7, ['ramp', 'mana_rock'])
  }
  if (wincons === 0 && cardCount >= 60) {
    issue('no-wincon', 'No explicit win condition', 'Nothing closes the game outright — the deck leans fully on combat math.',
      0.4, ['win_condition'])
  }

  return {
    cardCount,
    landCount,
    manaSources,
    avgManaValue,
    roleCounts: [...roleTotals.entries()]
      .map(([role, count]) => ({ role, count }))
      .sort((a, b) => b.count - a.count || a.role.localeCompare(b.role)),
    issues,
    profiles: entries.map((e) => ({ ...e.profile, quantity: e.quantity })),
  }
}
