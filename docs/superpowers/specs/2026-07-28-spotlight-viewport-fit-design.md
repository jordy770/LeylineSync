# Spotlight Viewport Fit — Design Spec

**Date:** 2026-07-28
**Problem:** On the BOARD view, a player with many permanents makes the spotlight
panel grow past the viewport, so the page becomes scrollable. On a TV/couch view
scrolling is unacceptable — everything must stay visible within the viewport.

**Scope:** Spotlight view only (`FocusSeatPanel` + its containing branch in
`components/GameBoard.tsx`). The grid (quadrant) view already caps at 10 cards
per panel and is explicitly out of scope.

## Decisions (validated with Jordy)

1. **Compact representation is allowed.** Lands collapse into a summary chip;
   identical duplicates stack with a counter. Interesting cards stay large.
2. **After compacting, cards auto-shrink to fit.** No card floor, no "+N more"
   pile: the column count grows with the card count so everything always fits.
   Guarantee: no page scroll, ever.
3. **Fit mechanism: computed columns** (measured container + pure math), not
   count-based breakpoints and not CSS `transform: scale()`.

## Section 1 — Structure & compact rules

### Height lock (spotlight branch only)

- The spotlight `motion.div` (`GameBoard.tsx` ~line 186) changes from
  `min-h-[72vh]` (grows with content) to a fixed height, reusing the offsets the
  board already defines: `h-[calc(100vh-5.75rem-2rem)]` (header + root padding)
  and the existing `[@media(max-height:640px)]` variant based on
  `calc(100svh-8rem)`. `overflow-hidden` acts as a safety net. Exact rem values
  are settled at implementation by measuring the rendered chrome.
- `FocusSeatPanel` becomes a flex column: header row keeps its natural height,
  the card zone gets `flex-1 min-h-0` and is the measured fit container.
- The grid view branch keeps its current `min-h` behavior — unchanged.

### Lands → header chip

- Lands no longer render as card tiles in the spotlight grid. Instead one chip
  in the panel header next to the Phase box: **"Lands 12 · 3 open"** (count +
  untapped count), mirroring the numbers `MiniPlayerWidget` already shows.
- **Exceptions — a land stays as a tile when it is:** animated (`card.animated`,
  can attack), has attachments, is attached to something, or has damage marked.
  Those are exactly the lands the table needs to see.

### Duplicate stacking (×N)

- Cards stack into one tile when they share **name + tapped status** and have
  **no badges** (no attachments, not attached, no damage, not animated).
- A stacked tile shows a **×N** badge (bottom-right, same pill style as the
  existing `BoardCardBadges`).
- Tapped and untapped copies of the same token remain two separate tiles — that
  difference is combat-relevant.
- The commander never stacks.

## Section 2 — Fit algorithm

### `fitCardColumns(width, height, count, gap)` — pure function in `lib/game/`

```
for cols = 1 .. count:
  cardW  = (width − (cols−1)·gap) / cols
  cardH  = cardW · 3/2                      // aspect 2:3
  rows   = ceil(count / cols)
  totalH = rows·cardH + (rows−1)·gap
  return first (smallest) cols where totalH ≤ height
fallback: cols = count (single row, extreme aspect)
```

- A `ResizeObserver` on the card zone supplies width/height; the result drives
  `grid-template-columns: repeat(n, 1fr)`.
- Cards remain `w-full aspect-[2/3]` — **no change to `MotionCard`**.

### Edge cases

- Zero nonland tiles → existing "Battlefield empty" placeholder, unchanged.
- Column-count changes animate via the existing framer-motion `layout` props;
  on TV (`tv-flat` / `reducedMotion: 'always'`) animation is already off.
- First render before the observer fires: start at the current default column
  count (5) to avoid a layout flash.

## Verification / success criteria

1. Unit test for `fitCardColumns`: result always fits within `height`;
   column count is monotonically non-decreasing in `count`.
2. `openwolf designqc` against a full test board (30+ permanents):
   **no vertical scrollbar on the `/board/[id]` route** and all nonland,
   non-stacked permanents individually visible.

## Out of scope

- Grid (quadrant) view overflow.
- Changes to `MotionCard`, `StackRail`, `MiniPlayerWidget`.
- Any server/data changes — this is purely presentational.
