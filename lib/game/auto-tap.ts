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
