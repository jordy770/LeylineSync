// Conflict arbiter — when a card is wanted by more decks than you own copies
// of, decide WHERE it delivers the most value. PURE core: value = commander
// synergy (data-driven profiles) + how squarely the card's roles fill the
// deck's diagnosed gaps. Every point is traceable to a reason string.

import type { ClassifiedCard } from './card-engine'
import { COMMANDER_PROFILES, commanderSynergy } from './commander-profiles'
import type { DeckIssue } from './deck-analyzer'
import type { Role } from './models'

export interface ArbiterDeck {
  id: string
  name: string
  /** The deck's commander card name (front face), when known. */
  commanderName: string | null
  /** Diagnosed issues from analyzeDeckRoles — gap roles raise the card's value. */
  issues: DeckIssue[]
}

export interface DeckVerdict {
  deckId: string
  deckName: string
  value: number
  reasons: string[]
}

export interface Arbitration {
  cardName: string
  ranking: DeckVerdict[]
  /** The winner (highest value); ties keep the first deck. */
  bestDeckId: string | null
}

const GAP_POINTS = 2

export function arbitrateConflict(card: ClassifiedCard, decks: ArbiterDeck[]): Arbitration {
  const cardRoles = new Set<Role>(card.roles.map((r) => r.role))

  const ranking: DeckVerdict[] = decks.map((deck) => {
    const reasons: string[] = []
    let value = 0

    const profile = deck.commanderName
      ? COMMANDER_PROFILES.find((p) => p.name.toLowerCase() === deck.commanderName!.toLowerCase())
      : undefined
    if (profile) {
      const syn = commanderSynergy(card, profile)
      if (syn.score !== 0) {
        value += syn.score
        reasons.push(
          `${profile.name.split(',')[0]} wants ${syn.contributions.map((c) => c.key.replace(/_/g, ' ')).join(', ')} (+${syn.score})`,
        )
      }
    }

    const gapRoles = new Set(deck.issues.flatMap((i) => i.recommendedRoles))
    const fills = [...cardRoles].filter((r) => gapRoles.has(r))
    if (fills.length > 0) {
      const pts = fills.length * GAP_POINTS
      value += pts
      reasons.push(`fills this deck's ${fills.map((r) => r.replace(/_/g, ' ')).join(' + ')} gap (+${pts})`)
    }

    if (reasons.length === 0) reasons.push('no profiled synergy and no diagnosed gap it fills')
    return { deckId: deck.id, deckName: deck.name, value, reasons }
  })

  ranking.sort((a, b) => b.value - a.value)
  return {
    cardName: card.name,
    ranking,
    bestDeckId: ranking[0] && ranking[0].value > 0 ? ranking[0].deckId : ranking[0]?.deckId ?? null,
  }
}
