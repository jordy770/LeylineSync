// Commander profiles — DATA, not code: what each commander's deck wants, as
// weighted likes over the engine's role/tag vocabulary. commanderSynergy()
// scores a card profile against a commander profile and explains every point.
//
// Extend freely: add a profile per commander you care about. Unknown commanders
// simply score 0 everywhere (the deck-level needs analysis still applies).

import type { ClassifiedCard } from './card-engine'

export interface CommanderProfile {
  /** Exact commander card name (front face). */
  name: string
  /** role-or-tag → weight. Positive = wants it, negative = anti-synergy. */
  likes: Record<string, number>
}

export const COMMANDER_PROFILES: CommanderProfile[] = [
  {
    name: "Y'shtola, Night's Blessed",
    likes: { instant: 3, sorcery: 2, spellslinger: 3, cheap: 2, card_draw: 2, flash: 2, lifedrain: 2 },
  },
  {
    name: 'Wilhelt, the Rotcleaver',
    likes: { zombie: 4, aristocrats: 3, dies_trigger: 3, token_generator: 2, sacrifice_outlet: 2, recursion: 2, tribal_payoff: 2 },
  },
  {
    name: 'Prosper, Tome-Bound',
    likes: { treasure: 4, graveyard_casting: 3, sacrifice_outlet: 2, artifacts_matter: 2, value_engine: 2 },
  },
  {
    name: 'Talrand, Sky Summoner',
    likes: { instant: 4, sorcery: 3, spellslinger: 4, counterspell: 3, cheap: 2, card_draw: 2, token_generator: 1 },
  },
  {
    name: 'Meren of Clan Nel Toth',
    likes: { dies_trigger: 3, sacrifice_outlet: 4, aristocrats: 3, reanimator: 3, recursion: 3, etb: 2, mana_dork: 1 },
  },
  {
    name: 'Kaalia of the Vast',
    likes: { angel: 4, demon: 4, dragon: 4, high_cmc: 2, attack_trigger: 2, evasion: 2, protection: 2 },
  },
  {
    name: 'Ezuri, Renegade Leader',
    likes: { elf: 4, mana_dork: 3, tribal_payoff: 3, anthem: 2, counters_matter: 1, evasion: 1 },
  },
  {
    name: 'Krenko, Mob Boss',
    likes: { goblin: 4, token_generator: 3, anthem: 2, sacrifice_outlet: 2, tribal_payoff: 3, cheap: 1 },
  },
  {
    name: 'Atraxa, Praetors’ Voice',
    likes: { proliferate: 4, counters_matter: 4, planeswalker: 3, lifegain: 1, stax: 1 },
  },
  {
    name: 'Breya, Etherium Shaper',
    likes: { artifacts_matter: 4, artifact: 3, treasure: 3, token_generator: 2, sacrifice_outlet: 3, combo_piece: 2 },
  },
  {
    name: 'Edgar Markov',
    likes: { vampire: 4, token_generator: 3, aristocrats: 3, anthem: 2, tribal_payoff: 3, lifedrain: 2 },
  },
  {
    name: 'Millicent, Restless Revenant',
    likes: { spirit: 4, token_generator: 3, evasion: 2, anthem: 2, tribal_payoff: 3, dies_trigger: 2 },
  },
]

export interface SynergyContribution {
  key: string
  weight: number
}

export interface CommanderSynergy {
  commander: string
  score: number
  contributions: SynergyContribution[]
}

/** Score one card against one commander; every point traces to a like. */
export function commanderSynergy(card: ClassifiedCard, profile: CommanderProfile): CommanderSynergy {
  const cardKeys = new Set<string>([...card.tags, ...card.roles.map((r) => r.role)])
  const contributions: SynergyContribution[] = []
  let score = 0
  for (const [key, weight] of Object.entries(profile.likes)) {
    if (!cardKeys.has(key)) continue
    contributions.push({ key, weight })
    score += weight
  }
  contributions.sort((a, b) => b.weight - a.weight)
  return { commander: profile.name, score, contributions }
}

/** All known commanders, best match first — the Playground's synergy panel. */
export function allCommanderSynergies(card: ClassifiedCard): CommanderSynergy[] {
  return COMMANDER_PROFILES.map((p) => commanderSynergy(card, p))
    .filter((s) => s.score !== 0)
    .sort((a, b) => b.score - a.score)
}
