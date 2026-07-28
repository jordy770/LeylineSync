// Spotlight board panel fit helpers (spec: docs/superpowers/specs/
// 2026-07-28-spotlight-viewport-fit-design.md). Pure functions — the React
// side feeds in a measured container and renders whatever comes back.

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
