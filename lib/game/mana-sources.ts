import { isAddManaBehaviorAction, normalizeCardBehaviorToV2 } from './card-behavior'
import { manaColors } from './mana'
import type { CardScript, ManaColor } from './types'

const BASIC_LAND_COLOR: Record<string, ManaColor> = {
  plains: 'W', island: 'U', swamp: 'B', mountain: 'R', forest: 'G', wastes: 'C',
}

// Full mana profile of a permanent: the specific colours it can tap for, whether
// it has an any-colour/commander source, and the mana produced per tap (the
// largest single ability — e.g. Sol Ring = 2). null when it makes no mana.
export type ManaSourceInfo = { colors: ManaColor[]; any: boolean; amount: number }

export function manaSourceColors(
  script: CardScript | null | undefined,
  typeLine?: string | null,
): ManaSourceInfo | null {
  const v2 = normalizeCardBehaviorToV2(script ?? null, typeLine ?? undefined)
  const manaAbilities = v2.activated_abilities?.filter((a) => a.is_mana_ability) ?? []
  if (manaAbilities.length > 0) {
    const colors = new Set<ManaColor>()
    let any = false
    let amount = 1
    for (const ability of manaAbilities) {
      let perTap = 0
      for (const effect of ability.effects) {
        if (!isAddManaBehaviorAction(effect)) continue
        if (effect.color === 'any' || effect.color === 'commander') any = true
        else colors.add(effect.color as ManaColor)
        perTap += effect.amount ?? 1
      }
      if (perTap > amount) amount = perTap
    }
    if (any || colors.size > 0) return { colors: [...colors], any, amount }
  }
  const tl = (typeLine ?? '').toLowerCase()
  const basics = Object.entries(BASIC_LAND_COLOR).filter(([sub]) => tl.includes(sub)).map(([, c]) => c)
  if (basics.length > 0) return { colors: basics, any: false, amount: 1 }
  return null
}

/**
 * What mana colours a permanent can make, collapsed for the controller's own
 * affordability hint:
 *   ManaColor[]  — a single fixed colour
 *   'flexible'   — any-colour / commander / multi-colour: a wildcard source
 *   null         — not a recognizable mana source
 */
export function producibleColorsFromScript(
  script: CardScript | null | undefined,
  typeLine?: string | null,
): ManaColor[] | 'flexible' | null {
  const info = manaSourceColors(script, typeLine)
  if (!info) return null
  if (info.any || info.colors.length > 1) return 'flexible'
  if (info.colors.length === 1) return [info.colors[0]]
  return null
}

// The Mana-font hybrid class suffix for a two-colour guild pair (e.g. B+G → 'bg'),
// or null when the pair isn't a guild combo (e.g. includes colourless).
const GUILD_HYBRID: Record<string, string> = {
  WU: 'wu', WB: 'wb', UB: 'ub', UR: 'ur', BR: 'br', BG: 'bg', RG: 'rg', RW: 'rw', GW: 'gw', GU: 'gu',
}
export function guildHybridKey(colors: ManaColor[]): string | null {
  if (colors.length !== 2 || colors.includes('C')) return null
  const [a, b] = colors
  return GUILD_HYBRID[`${a}${b}`] ?? GUILD_HYBRID[`${b}${a}`] ?? null
}

// Untapped mana an opponent has available, as a SOURCE COUNT per colour (v1
// approximation: each source counts 1, ignoring amount>1 and conditional/cost
// abilities). `pairs` = two-colour guild sources keyed by hybrid suffix ('bg'),
// `flexible` = any-colour / 3+ colour sources (the gold pip); `total` = all.
export type ManaAvailability = {
  byColor: Partial<Record<ManaColor, number>>
  pairs: Partial<Record<string, number>>
  flexible: number
  total: number
}

export const emptyManaAvailability: ManaAvailability = { byColor: {}, pairs: {}, flexible: 0, total: 0 }

export function aggregateUntappedMana(
  cards: Array<{ is_tapped?: boolean; script?: CardScript | null; type_line?: string | null }>,
): ManaAvailability {
  const byColor: Partial<Record<ManaColor, number>> = {}
  const pairs: Partial<Record<string, number>> = {}
  let flexible = 0
  let total = 0
  for (const card of cards) {
    if (card.is_tapped) continue
    const info = manaSourceColors(card.script, card.type_line)
    if (!info) continue
    total += 1
    if (info.any || info.colors.length >= 3) {
      flexible += 1
    } else if (info.colors.length === 2) {
      const key = guildHybridKey(info.colors)
      if (key) pairs[key] = (pairs[key] ?? 0) + 1
      else flexible += 1
    } else if (info.colors.length === 1) {
      const color = info.colors[0]
      byColor[color] = (byColor[color] ?? 0) + 1
    } else {
      flexible += 1
    }
  }
  return { byColor, pairs, flexible, total }
}

// WUBRG + C order for rendering the pips consistently.
export const manaPipOrder: ManaColor[] = manaColors
