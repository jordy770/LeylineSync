// Pure deck-statistics helpers for the deck editor (no I/O, fully unit-testable).
// All operate on the deck's card lines (a catalog card + a quantity).

import type { DeckCardLine, LinkedCard, ManaColor } from './types'

export const DECK_MANA_COLORS: ManaColor[] = ['W', 'U', 'B', 'R', 'G']

const isLand = (card: LinkedCard | null) => (card?.type_line ?? '').toLowerCase().includes('land')

/**
 * Mana value (converted mana cost) of a mana cost string like "{2}{W}{U}".
 * Generic numbers add their value; each coloured/hybrid/Phyrexian symbol adds 1;
 * {X} adds 0. {2/W}-style hybrids count the numeric side (mana value 2). Approximate
 * but good enough for a curve.
 */
export function manaValue(manaCost?: string | null): number {
  const symbols = (manaCost ?? '').match(/\{([^}]+)\}/g)
  if (!symbols) return 0
  let total = 0
  for (const raw of symbols) {
    const token = raw.slice(1, -1) // strip { }
    if (/^\d+$/.test(token)) {
      total += Number(token)
    } else if (token.toUpperCase() === 'X') {
      total += 0
    } else if (token.includes('/')) {
      // Hybrid: take the numeric side if present (e.g. {2/W} -> 2), else 1.
      const numeric = token.split('/').find((p) => /^\d+$/.test(p))
      total += numeric ? Number(numeric) : 1
    } else {
      total += 1 // a single coloured/colourless/Phyrexian pip
    }
  }
  return total
}

/** The deck's primary type breakdown (a card counts once, by its first matching type). */
const TYPE_ORDER = ['creature', 'planeswalker', 'instant', 'sorcery', 'artifact', 'enchantment', 'land'] as const
export type DeckType = (typeof TYPE_ORDER)[number] | 'other'

export function deckTypeBreakdown(lines: DeckCardLine[]): Record<DeckType, number> {
  const out = { creature: 0, planeswalker: 0, instant: 0, sorcery: 0, artifact: 0, enchantment: 0, land: 0, other: 0 }
  for (const line of lines) {
    const tl = (line.card?.type_line ?? '').toLowerCase()
    const type = TYPE_ORDER.find((t) => tl.includes(t)) ?? 'other'
    out[type] += line.quantity
  }
  return out
}

/** Pip counts per colour across the deck's mana costs (multi-pip cards count each). */
export function deckColorPips(lines: DeckCardLine[]): Record<ManaColor, number> {
  const out: Record<ManaColor, number> = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }
  for (const line of lines) {
    const mc = (line.card?.mana_cost ?? '').toUpperCase()
    for (const color of DECK_MANA_COLORS) {
      const pips = (mc.match(new RegExp(color, 'g')) ?? []).length
      out[color] += pips * line.quantity
    }
  }
  return out
}

export type CurveBucket = { label: string; count: number }

/** Mana curve over non-land cards, bucketed 0,1,2,3,4,5,6,7+. */
export function deckManaCurve(lines: DeckCardLine[]): CurveBucket[] {
  const buckets = [0, 0, 0, 0, 0, 0, 0, 0] // index 7 = "7+"
  for (const line of lines) {
    if (isLand(line.card)) continue
    const mv = Math.min(7, manaValue(line.card?.mana_cost))
    buckets[mv] += line.quantity
  }
  return buckets.map((count, i) => ({ label: i === 7 ? '7+' : String(i), count }))
}

/** Average mana value of the non-land cards (0 if none). */
export function deckAverageManaValue(lines: DeckCardLine[]): number {
  let total = 0
  let n = 0
  for (const line of lines) {
    if (isLand(line.card)) continue
    total += manaValue(line.card?.mana_cost) * line.quantity
    n += line.quantity
  }
  return n === 0 ? 0 : Math.round((total / n) * 10) / 10
}

export function deckLandCount(lines: DeckCardLine[]): number {
  return lines.reduce((sum, line) => sum + (isLand(line.card) ? line.quantity : 0), 0)
}

const isBasicLand = (card: LinkedCard | null) => {
  const tl = (card?.type_line ?? '').toLowerCase()
  return tl.includes('basic') && tl.includes('land')
}

/**
 * Singleton (Commander) violations: non-basic cards listed more than once.
 * Returns the offending card names with their quantity.
 */
export function deckSingletonViolations(lines: DeckCardLine[]): { name: string; quantity: number }[] {
  return lines
    .filter((line) => line.quantity > 1 && !isBasicLand(line.card))
    .map((line) => ({ name: line.card?.name ?? line.card_id, quantity: line.quantity }))
}

/**
 * A card's colour identity, APPROXIMATED from the mana symbols in its mana cost and
 * rules text (so an activated ability like "{R}: ..." counts red). Misses colour
 * indicators and "all colours" text — a deck-builder guide, not a rules oracle.
 */
export function cardColorIdentity(card: { mana_cost?: string | null; oracle_text?: string | null } | null): Set<ManaColor> {
  const identity = new Set<ManaColor>()
  const scan = (text: string | null | undefined) => {
    for (const match of (text ?? '').toUpperCase().matchAll(/\{([^}]+)\}/g)) {
      for (const ch of match[1]!) {
        if ((DECK_MANA_COLORS as string[]).includes(ch)) identity.add(ch as ManaColor)
      }
    }
  }
  scan(card?.mana_cost)
  scan(card?.oracle_text)
  return identity
}

/**
 * Cards whose colour identity falls outside the commander's (illegal in Commander).
 * Returns each offending card with the off-identity colours. Empty if no commander.
 */
export function deckColorIdentityViolations(
  lines: DeckCardLine[],
  commander: { mana_cost?: string | null; oracle_text?: string | null } | null,
): { name: string; colors: ManaColor[] }[] {
  if (!commander) return []
  const allowed = cardColorIdentity(commander)
  const out: { name: string; colors: ManaColor[] }[] = []
  for (const line of lines) {
    const offending = [...cardColorIdentity(line.card)].filter((c) => !allowed.has(c))
    if (offending.length > 0) {
      out.push({ name: line.card?.name ?? line.card_id, colors: offending })
    }
  }
  return out
}
