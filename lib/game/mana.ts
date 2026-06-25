import type { ManaColor } from './types'

export const manaColors: ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C']

export type ManaPayment = Partial<Record<ManaColor, number>>

export type ParsedManaCost = {
  generic: number
  colored: Record<ManaColor, number>
}

export function parseManaCost(manaCost?: string | null): ParsedManaCost {
  const colored = createEmptyColorCounts()
  let generic = 0

  if (!manaCost) {
    return { generic, colored }
  }

  const matches = manaCost.toUpperCase().matchAll(/\{?([0-9]+|[WUBRGC])\}?/g)

  for (const match of matches) {
    const symbol = match[1]

    if (/^[0-9]+$/.test(symbol)) {
      generic += Number(symbol)
    } else if (isManaColor(symbol)) {
      colored[symbol] += 1
    }
  }

  return { generic, colored }
}

// Colour identity (WUBRG, stable order) derived from a card's mana cost + rules
// text — the {W/U/B/R/G} symbols it shows. No color_identity column exists, so
// this mirrors the controller's own commander-identity derivation. Colourless
// ('C') is never part of identity.
export function colorIdentityFromCard(card: {
  mana_cost?: string | null
  oracle_text?: string | null
}): ManaColor[] {
  const found = new Set<ManaColor>()
  const scan = (text?: string | null) => {
    for (const match of (text ?? '').toUpperCase().matchAll(/\{([^}]+)\}/g)) {
      for (const ch of match[1] ?? '') {
        if ('WUBRG'.includes(ch)) found.add(ch as ManaColor)
      }
    }
  }
  scan(card.mana_cost)
  scan(card.oracle_text)
  return manaColors.filter((color) => found.has(color))
}

export function getPaymentTotal(payment: ManaPayment) {
  return manaColors.reduce((total, color) => total + (payment[color] ?? 0), 0)
}

export function normalizeManaPayment(payment: ManaPayment): Record<string, number> {
  return manaColors.reduce<Record<string, number>>((result, color) => {
    const amount = payment[color] ?? 0

    if (amount > 0) {
      result[color] = amount
    }

    return result
  }, {})
}

export function incrementPaymentColor(
  payment: ManaPayment,
  color: ManaColor,
  maxTotal: number,
) {
  if (getPaymentTotal(payment) >= maxTotal) {
    return payment
  }

  return {
    ...payment,
    [color]: (payment[color] ?? 0) + 1,
  }
}

export function decrementPaymentColor(payment: ManaPayment, color: ManaColor) {
  const nextAmount = Math.max(0, (payment[color] ?? 0) - 1)
  const nextPayment = { ...payment }

  if (nextAmount === 0) {
    delete nextPayment[color]
  } else {
    nextPayment[color] = nextAmount
  }

  return nextPayment
}

function createEmptyColorCounts(): Record<ManaColor, number> {
  return {
    W: 0,
    U: 0,
    B: 0,
    R: 0,
    G: 0,
    C: 0,
  }
}

function isManaColor(value: string): value is ManaColor {
  return manaColors.includes(value as ManaColor)
}
