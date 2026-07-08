// Leyline Intelligence Engine — core models. Framework-free and UI-free by
// contract: everything in lib/intelligence is pure data + pure functions so the
// same engine can run in API routes, scripts (tag-backfill) and tests.
//
// Design principles (decided 2026-07-08):
//   * No AI, no network — deterministic rules over oracle text/type/keywords.
//   * Multi-role: a card is a PROFILE (roles + tags + rule hits), not one score.
//   * Explainable: every conclusion traces back to a named, versioned rule.
//   * The legacy SynergyTag vocabulary (lib/collection/synergy/tagger.ts) is a
//     COMPATIBILITY VIEW over this engine — power-score/upgrade-scanner keep
//     reading identical tags until they migrate to roles.

/** Broad, curated role vocabulary. Extend freely — rules reference these. */
export const ROLES = [
  'ramp', 'mana_rock', 'mana_dork', 'mana_fixing',
  'card_draw', 'draw_engine', 'wheel',
  'spot_removal', 'board_wipe', 'counterspell', 'discard', 'graveyard_hate', 'stax',
  'protection', 'tutor', 'recursion', 'reanimator', 'blink',
  'token_generator', 'sacrifice_outlet', 'aristocrats',
  'lifegain', 'lifedrain', 'mill', 'landfall', 'proliferate', 'counters_matter',
  'artifacts_matter', 'enchantments_matter', 'spellslinger', 'storm',
  'equipment', 'aura', 'vehicle', 'clone',
  'extra_turns', 'extra_combat', 'politics',
  'treasure', 'energy',
  'win_condition', 'combo_piece', 'value_engine',
  'evasion', 'anthem', 'tribal_payoff',
] as const
export type Role = (typeof ROLES)[number]

/** The card shape rules see. Matches co_card_oracle / the Scryfall oracle dump. */
export interface CardInput {
  name: string
  typeLine: string
  oracleText: string | null
  keywords: string[]
  cmc: number
  colorIdentity?: string[]
}

/** Precomputed lowercase views so 100s of rules don't re-lowercase per rule. */
export interface RuleContext {
  card: CardInput
  text: string
  type: string
  keywords: string[]
  /** "whenever …" / "at the beginning of …" — a repeatable effect. */
  repeatable: boolean
}

/** What firing one rule contributes to the profile. */
export interface RuleGrant {
  roles?: Role[]
  /** Free-form tags (lowercase snake_case): creature types, mechanics, hints. */
  tags?: string[]
  /** 1–4; used by the legacy-tag view and role weighting. Default 1. */
  weight?: number
}

export interface Rule extends RuleGrant {
  /** Stable id, 'category.slug' — the Playground and backfills cite this. */
  id: string
  /** One human sentence: WHY this rule fires ("Oracle text contains 'draw a card'"). */
  description: string
  /** Bump when the rule's semantics change → re-backfill picks it up. */
  version: number
  /**
   * When set, this rule also feeds the LEGACY SynergyTag view (the contract
   * power-score/upgrade-scanner/co_card_tags read). The compat pipeline in
   * card-engine reproduces the old tagger's math (repeatable bump, max-weight
   * clamp, land/efficiency post-steps) byte-for-byte over these.
   */
  legacyTag?: string
  /** Return false/null to pass, true to fire, or a string as evidence excerpt. */
  test: (ctx: RuleContext) => boolean | string | null
}

export interface RuleHit {
  ruleId: string
  description: string
  /** Oracle-text excerpt that made the rule fire, when the rule provides one. */
  evidence?: string
}

/** The full analysis of one card — the engine's central output. */
export interface CardProfile {
  name: string
  roles: { role: Role; weight: number }[]
  tags: string[]
  hits: RuleHit[]
}

export function buildContext(card: CardInput): RuleContext {
  const text = (card.oracleText ?? '').toLowerCase()
  return {
    card,
    text,
    type: card.typeLine.toLowerCase(),
    keywords: card.keywords.map((k) => k.toLowerCase()),
    repeatable: /\bwhenever\b|at the beginning of/.test(text),
  }
}
