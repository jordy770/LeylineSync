// Synergy tagger — COMPATIBILITY VIEW over the Leyline Intelligence Engine
// (lib/intelligence). The original regex heuristics live on as named, versioned
// rules in lib/intelligence/rules/legacy.ts; classifyCard reproduces the old
// pipeline (repeatable bump, max-weight clamp, land/efficiency post-steps)
// byte-for-byte, so this module's output is unchanged. The SynergyTag registry
// below remains the contract that power-score + upgrade-scanner + co_card_tags
// read — new roles/tags only exist on the engine's CardProfile until consumers
// migrate.

import { classifyCard } from '../../intelligence/card-engine'

export type SynergyTag =
  | 'ramp'
  | 'removal'
  | 'board_wipe'
  | 'counterspell'
  | 'card_draw'
  | 'tutor'
  | 'recursion'
  | 'reanimation'
  | 'protection'
  | 'token'
  | 'artifact'
  | 'enchantment'
  | 'lifegain'
  | 'lifeloss'
  | 'sacrifice'
  | 'spellslinger'
  | 'blink'
  | 'graveyard'
  | 'land'
  | 'win_condition'

export interface CardTag {
  tag: SynergyTag
  weight: number
}

export interface TaggerCard {
  name: string
  typeLine: string
  oracleText: string | null
  keywords: string[]
  cmc: number
}

export function tagCard(card: TaggerCard): CardTag[] {
  return classifyCard(card).legacyTags as CardTag[]
}
