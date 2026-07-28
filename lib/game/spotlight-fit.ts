import type { BoardCard } from './types'

// Spotlight board panel fit helpers (spec: docs/superpowers/specs/
// 2026-07-28-spotlight-viewport-fit-design.md). Pure functions — the React
// side feeds in a measured container and renders whatever comes back.

export type SpotlightTile = { card: BoardCard; count: number }
export type SpotlightPartition = { tiles: SpotlightTile[]; landTotal: number; landOpen: number }

// Smallest column count that lets `count` cards (aspect 2:3) fit width×height
// with `gap` px between cells. May exceed `count`: empty columns shrink cards,
// which is how one huge card still fits a short panel. Give-up floor at ≤8px
// card width — the panel's overflow-hidden catches that pathological case.
export function fitCardColumns(width: number, height: number, count: number, gap: number): number {
  if (count <= 0 || width <= 0 || height <= 0) return 1
  for (let cols = 1; ; cols++) {
    const cardW = (width - (cols - 1) * gap) / cols
    if (cardW <= 8) return cols
    const rows = Math.ceil(count / cols)
    const totalH = rows * cardW * 1.5 + (rows - 1) * gap
    if (totalH <= height) return cols
  }
}

// Compact a seat's battlefield for the spotlight panel: plain lands fold into
// the header chip (landTotal · landOpen), identical plain duplicates fold into
// one ×N tile. "Plain" = nothing the table needs to see per-copy: no badges
// (animated / attached / hosting / damaged), no counters, not face-down, not
// legendary (the commander guard — BoardCard carries no is_commander).
export function partitionSpotlightCards(cards: BoardCard[]): SpotlightPartition {
  const typeOf = (c: BoardCard) => c.type_line?.toLowerCase() ?? ''
  const hostIds = new Set(cards.filter((c) => c.attached_to).map((c) => c.attached_to as string))
  const hasBadge = (c: BoardCard) =>
    Boolean(c.animated) || Boolean(c.attached_to) || hostIds.has(c.id) || (c.damage_marked ?? 0) > 0
  const hasCounters = (c: BoardCard) =>
    (c.plus_one_counters ?? 0) > 0 || Object.values(c.counters ?? {}).some((n) => n > 0)
  const isPlain = (c: BoardCard) =>
    !hasBadge(c) &&
    !hasCounters(c) &&
    !c.is_face_down &&
    !typeOf(c).includes('legendary')

  const lands = cards.filter((c) => typeOf(c).includes('land'))
  const tiles: SpotlightTile[] = []
  const stackByKey = new Map<string, SpotlightTile>()
  for (const c of cards) {
    // Counter-bearing lands (Gemstone Mine, storage lands) stay visible: the
    // counters ARE the information the chip would hide.
    if (typeOf(c).includes('land') && !hasBadge(c) && !hasCounters(c)) continue // → chip
    if (!isPlain(c)) {
      tiles.push({ card: c, count: 1 })
      continue
    }
    const key = `${c.name}|${c.is_tapped}`
    const existing = stackByKey.get(key)
    if (existing) {
      existing.count += 1
    } else {
      const tile = { card: c, count: 1 }
      stackByKey.set(key, tile)
      tiles.push(tile)
    }
  }
  return {
    tiles,
    landTotal: lands.length,
    landOpen: lands.filter((c) => !c.is_tapped).length,
  }
}
