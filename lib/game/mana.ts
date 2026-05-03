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
