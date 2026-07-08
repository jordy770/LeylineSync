// Card engine — runs the rule registry over one card and produces its PROFILE
// (roles + tags + explainable rule hits) plus the legacy SynergyTag view.
//
// The legacy view reproduces the ORIGINAL tagger pipeline exactly (repeatable
// bump → max-weight clamp per tag → land-drops-ramp → efficiency adjustment),
// so every existing score (power-score, upgrade-scanner, co_card_tags) is
// byte-identical until consumers migrate to roles. Pinned by
// tests/unit/synergy-tagger.test.ts.

import type { CardInput, CardProfile, Role, Rule, RuleHit } from './models'
import { buildContext } from './models'
import { LEGACY_RULES } from './rules/legacy'
import { EXTENDED_RULES } from './rules/extended'

export const ALL_RULES: Rule[] = [...LEGACY_RULES, ...EXTENDED_RULES]

const MAX_WEIGHT = 4
const EFFICIENCY_TAGS = new Set(['removal', 'counterspell', 'card_draw', 'ramp', 'tutor'])
const REPEATABLE_BUMP = new Set([
  'card_draw', 'token', 'lifegain', 'lifeloss', 'sacrifice', 'ramp', 'graveyard', 'reanimation',
])

export interface ClassifiedCard extends CardProfile {
  /** The legacy SynergyTag view — the contract co_card_tags/power-score read. */
  legacyTags: { tag: string; weight: number }[]
}

export function classifyCard(card: CardInput, rules: Rule[] = ALL_RULES): ClassifiedCard {
  const ctx = buildContext(card)

  const hits: RuleHit[] = []
  const roleWeights = new Map<Role, number>()
  const tags = new Set<string>()
  const legacy = new Map<string, number>()

  for (const rule of rules) {
    const outcome = rule.test(ctx)
    if (!outcome) continue
    hits.push({
      ruleId: rule.id,
      description: rule.description,
      ...(typeof outcome === 'string' ? { evidence: outcome } : {}),
    })
    const weight = rule.weight ?? 1
    for (const role of rule.roles ?? []) {
      roleWeights.set(role, Math.min(MAX_WEIGHT, Math.max(roleWeights.get(role) ?? 0, weight)))
    }
    for (const tag of rule.tags ?? []) tags.add(tag)
    if (rule.legacyTag) {
      // Original bump(): repeatable engines get +1 BEFORE the max/clamp.
      const w = REPEATABLE_BUMP.has(rule.legacyTag) && ctx.repeatable ? weight + 1 : weight
      legacy.set(rule.legacyTag, Math.min(MAX_WEIGHT, Math.max(legacy.get(rule.legacyTag) ?? 0, w)))
    }
  }

  // Original post-step: a land tapping for mana is not "ramp".
  if (/\bland\b/.test(ctx.type)) legacy.delete('ramp')

  // Original post-step: cheap interaction outranks clunky (efficiency roles only).
  for (const tag of EFFICIENCY_TAGS) {
    const w = legacy.get(tag)
    if (w === undefined) continue
    const adjusted = card.cmc <= 2 ? w + 1 : card.cmc >= 6 ? w - 1 : w
    legacy.set(tag, Math.min(MAX_WEIGHT, Math.max(1, adjusted)))
  }

  return {
    name: card.name,
    roles: [...roleWeights.entries()]
      .map(([role, weight]) => ({ role, weight }))
      .sort((a, b) => (b.weight - a.weight) || a.role.localeCompare(b.role)),
    tags: [...tags].sort(),
    hits,
    legacyTags: [...legacy.entries()]
      .map(([tag, weight]) => ({ tag, weight }))
      .sort((a, b) => (b.weight - a.weight) || a.tag.localeCompare(b.tag)),
  }
}
