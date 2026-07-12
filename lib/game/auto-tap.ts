import type { ManaColor, ManaPool } from './types'
import { manaColors, type ParsedManaCost } from './mana'

/**
 * An untapped, single-colour, cost-free mana source the auto-tapper may use:
 * `amount` mana of `color` for just a tap (no life/sacrifice/colour choice).
 */
export type ManaSource = { id: string; color: ManaColor; amount: number }

type ColorCounts = Record<ManaColor, number>

function poolToCounts(pool: ManaPool): ColorCounts {
  return manaColors.reduce((acc, c) => {
    acc[c] = pool[c] ?? 0
    return acc
  }, {} as ColorCounts)
}

/** Can `pool` pay `cost` outright? Coloured pips first, then generic from any leftover. */
function affordable(pool: ColorCounts, cost: ParsedManaCost): boolean {
  let leftover = 0
  for (const c of manaColors) {
    const have = pool[c]
    const pip = cost.colored[c]
    if (have < pip) return false
    leftover += have - pip
  }
  return leftover >= cost.generic
}

/** The first colour whose pips `pool` can't cover, or null when every colour is met. */
function shortColor(pool: ColorCounts, cost: ParsedManaCost): ManaColor | null {
  for (const c of manaColors) {
    if (pool[c] < cost.colored[c]) return c
  }
  return null
}

/**
 * Safe-greedy auto-tap plan: which `sources` to tap (each producing its colour)
 * so that floating `pool` + the tapped mana covers `cost`. Draws on the pool
 * first, taps a matching-colour source for each unmet coloured pip, then taps
 * any remaining source for the generic remainder.
 *
 * Returns the taps in order, an empty array when the pool already covers the
 * cost, or null when these (single-colour, cost-free) sources can't meet it —
 * the caller then leaves payment to the player.
 */
export function planAutoTap(
  cost: ParsedManaCost,
  pool: ManaPool,
  sources: ManaSource[],
): ManaSource[] | null {
  const working = poolToCounts(pool)
  const available = [...sources]
  const plan: ManaSource[] = []

  // Bounded by the source pool — every iteration consumes one source.
  while (!affordable(working, cost)) {
    const short = shortColor(working, cost)
    const idx = short !== null
      ? available.findIndex((s) => s.color === short)
      : available.length > 0 ? 0 : -1
    if (idx < 0) return null

    const [src] = available.splice(idx, 1)
    working[src.color] += src.amount
    plan.push(src)
  }

  return plan
}

/**
 * A tappable mana source that may offer a colour CHOICE: an explicit list
 * (dual/triome lands) or 'any' (Command Tower — `commander` marks sources the
 * engine validates against the commander's colour identity).
 */
export type FlexManaSource = {
  id: string
  colors: ManaColor[] | 'any'
  amount: number
  commander?: boolean
}

/** A planned tap with the colour chosen for it. */
export type PlannedTap = { id: string; color: ManaColor; amount: number; commander?: boolean }

/**
 * Flex-aware auto-tap plan (bug-1509: a Commander mana base is mostly duals and
 * Command Towers, which the single-colour planner couldn't use — auto-pay bailed
 * whenever a pip needed one of them).
 *
 * Strategy, safe-greedy:
 *  - a shortfall COLOURED pip taps the most-constrained source able to produce
 *    it (fixed colour first, then the narrowest dual, 'any'/'commander' last);
 *  - the GENERIC remainder only taps sources with a known colour list — a
 *    colour-choice 'any'/'commander' source is never burned on generic, since
 *    the deck's identity isn't known here (a chosen pip colour always is: any
 *    pip you're paying is a colour in your own spell).
 */
export function planAutoTapFlex(
  cost: ParsedManaCost,
  pool: ManaPool,
  sources: FlexManaSource[],
): PlannedTap[] | null {
  const working = poolToCounts(pool)
  const available = [...sources]
  const plan: PlannedTap[] = []

  while (!affordable(working, cost)) {
    const short = shortColor(working, cost)
    let pick = -1
    let color: ManaColor | null = null

    if (short !== null) {
      let bestFlexibility = Infinity
      for (let i = 0; i < available.length; i++) {
        const s = available[i]
        const producible = s.colors === 'any' || s.colors.includes(short)
        if (!producible) continue
        const flexibility = s.colors === 'any' ? Number.MAX_SAFE_INTEGER : s.colors.length
        if (flexibility < bestFlexibility) {
          bestFlexibility = flexibility
          pick = i
        }
      }
      color = short
    } else {
      pick = available.findIndex((s) => s.colors !== 'any')
      if (pick >= 0) color = (available[pick].colors as ManaColor[])[0]
    }

    if (pick < 0 || color === null) return null
    const [src] = available.splice(pick, 1)
    working[color] += src.amount
    plan.push({ id: src.id, color, amount: src.amount, commander: src.commander })
  }

  return plan
}
