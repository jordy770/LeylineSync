# Spotlight Viewport Fit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The spotlight panel on the BOARD view always fits inside the viewport — lands collapse to a header chip, duplicates stack with ×N, and remaining cards auto-shrink via a computed column count. No page scroll, ever.

**Architecture:** Two pure functions in a new `lib/game/spotlight-fit.ts` (`fitCardColumns` for the column math, `partitionSpotlightCards` for lands-collapse + duplicate-stacking), unit-tested with Node's test runner. `components/GameBoard.tsx` wires them into `FocusSeatPanel` with a `ResizeObserver` and locks the spotlight branch to viewport height. Spec: `docs/superpowers/specs/2026-07-28-spotlight-viewport-fit-design.md`.

**Tech Stack:** Next.js / React 18, Tailwind (arbitrary values + `[@media(max-height:640px)]` variants), framer-motion (existing `layout` props), Node `node:test` + `assert/strict` via `npm test`.

## Global Constraints

- **No server/data changes** — purely presentational; the board RPC payload is untouched.
- **Grid (quadrant) view unchanged** — height lock and compacting apply ONLY when `viewMode === 'spotlight'`.
- **No changes to `MotionCard`, `StackRail`, `MiniPlayerWidget`.**
- **TV performance:** no new blur, no new infinite animations; column changes animate through the existing framer-motion `layout` props, which are already disabled on TV via `MotionConfig reducedMotion`.
- **Spec deviation (approved rationale):** `BoardCard` has no `is_commander` field (only `ControllerCard` has it; `mapBoardCardRow` in `lib/game/data.ts:59` doesn't map it). The "commander never stacks" rule is implemented as **"legendary permanents never stack"** (`type_line` contains `legendary`) — commanders are always legendary, and this avoids a DB-function migration.
- Tests: Node test runner — `npm test -- unit/spotlight-fit` runs just the new file. Style mirrors `tests/unit/auto-pass.test.ts` (`import { test } from 'node:test'`, `assert` from `node:assert/strict`, relative imports like `../../lib/game/spotlight-fit`).
- Commits: conventional prefixes (`feat:`, `test:`, `docs:`, `chore(wolf):`), each ending with the line `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- OpenWolf: after creating files, update `.wolf/anatomy.md`; append one line per significant action to `.wolf/memory.md` (format `| HH:MM | description | file(s) | outcome | ~tokens |`).

---

### Task 1: `fitCardColumns` — column-count math

**Files:**
- Create: `lib/game/spotlight-fit.ts`
- Test: `tests/unit/spotlight-fit.test.ts`

**Interfaces:**
- Consumes: nothing (pure math).
- Produces: `fitCardColumns(width: number, height: number, count: number, gap: number): number` — the smallest column count such that `count` cards with aspect ratio 2:3 (`cardH = cardW * 1.5`), laid out in `ceil(count/cols)` rows with `gap` px between cells, fit within `width × height`. The column count MAY exceed `count` (empty columns make cards smaller — that is how a single huge card still fits a short panel). Degenerate inputs (`count <= 0`, `width <= 0`, `height <= 0`) return `1`. If even ~8px-wide cards would not fit, returns the column count where card width drops to ≤ 8px (give-up floor; the UI's `overflow-hidden` is the safety net).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/spotlight-fit.test.ts`:

```ts
// fitCardColumns — the spotlight board's "how many columns make N cards fit
// this panel" math (lib/game/spotlight-fit). Pure; aspect 2:3, gap in px.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitCardColumns } from '../../lib/game/spotlight-fit'

test('7 cards in a 900x620 panel fit at 5 columns', () => {
  // cols=4 → cardW 216, cardH 324, 2 rows → 660 > 620. cols=5 → cardW 170.4,
  // cardH 255.6, 2 rows → 523.2 ≤ 620.
  assert.equal(fitCardColumns(900, 620, 7, 12), 5)
})

test('22 cards in a 900x620 panel fit at 8 columns', () => {
  // cols=7 → 4 rows of 177.4 + gaps = 745.7 > 620. cols=8 → 3 rows of 153
  // + gaps = 483 ≤ 620.
  assert.equal(fitCardColumns(900, 620, 22, 12), 8)
})

test('a single card on a wide short panel gets extra columns so it fits the height', () => {
  // cols=1 → 900w/1350h, cols=2 → 444/666: both taller than 620.
  // cols=3 → 292/438 fits. Empty columns are the mechanism that shrinks cards.
  assert.equal(fitCardColumns(900, 620, 1, 12), 3)
})

test('result always fits the height (or hit the 8px give-up floor)', () => {
  for (let count = 1; count <= 40; count++) {
    const cols = fitCardColumns(900, 620, count, 12)
    const cardW = (900 - (cols - 1) * 12) / cols
    const rows = Math.ceil(count / cols)
    const totalH = rows * cardW * 1.5 + (rows - 1) * 12
    assert.ok(totalH <= 620 || cardW <= 8, `count=${count} cols=${cols} totalH=${totalH}`)
  }
})

test('columns are monotonically non-decreasing in card count', () => {
  let prev = 0
  for (let count = 1; count <= 30; count++) {
    const cols = fitCardColumns(900, 620, count, 12)
    assert.ok(cols >= prev, `count=${count}: ${cols} < ${prev}`)
    prev = cols
  }
})

test('degenerate inputs return 1 column', () => {
  assert.equal(fitCardColumns(900, 620, 0, 12), 1)
  assert.equal(fitCardColumns(0, 620, 5, 12), 1)
  assert.equal(fitCardColumns(900, 0, 5, 12), 1)
})

test('impossible panel returns the give-up floor instead of looping forever', () => {
  // 100px wide, 10px tall, 50 cards: nothing real fits; must still return.
  const cols = fitCardColumns(100, 10, 50, 8)
  assert.ok(Number.isFinite(cols) && cols >= 1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- unit/spotlight-fit`
Expected: FAIL — cannot find module `../../lib/game/spotlight-fit`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/game/spotlight-fit.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- unit/spotlight-fit`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/game/spotlight-fit.ts tests/unit/spotlight-fit.test.ts
git commit -m "feat(board): fitCardColumns — computed column count for spotlight viewport fit

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `partitionSpotlightCards` — lands chip + ×N stacking

**Files:**
- Modify: `lib/game/spotlight-fit.ts` (append)
- Test: `tests/unit/spotlight-fit.test.ts` (append)

**Interfaces:**
- Consumes: `BoardCard` from `lib/game/types` (fields used: `id`, `name`, `is_tapped`, `type_line`, `animated`, `attached_to`, `damage_marked`, `plus_one_counters`, `counters`, `is_face_down`).
- Produces:
  - `type SpotlightTile = { card: BoardCard; count: number }` — one rendered tile; `count > 1` means a ×N stack (card = first copy in original order).
  - `type SpotlightPartition = { tiles: SpotlightTile[]; landTotal: number; landOpen: number }`
  - `partitionSpotlightCards(cards: BoardCard[]): SpotlightPartition`

**Rules (from spec, exactly):**
1. `landTotal` = ALL lands (chip mirrors the mini-widget numbers); `landOpen` = untapped lands.
2. A land is REMOVED from tiles unless it has a badge: `animated`, is attached (`attached_to`), hosts an attachment (some other card's `attached_to` points at it), or `damage_marked > 0`. Badged lands stay as tiles AND still count in the chip.
3. Remaining cards stack when they share `name` + `is_tapped` AND every copy is "plain": no badge (rule 2's list), no `plus_one_counters`, no counter in the `counters` bag with value > 0 (a zero-valued key counts as no counter — Jordy's ruling 2026-07-28), not face-down, and `type_line` does not contain `legendary` (commander guard — see Global Constraints). Non-plain cards always render individually.
4. Original card order is preserved; a stack sits at its first copy's position.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/spotlight-fit.test.ts`: change the existing import to `import { fitCardColumns, partitionSpotlightCards } from '../../lib/game/spotlight-fit'` and add `import type { BoardCard } from '../../lib/game/types'` next to it at the TOP of the file (eslint `import/first`), then append below the existing tests:

```ts
let seq = 0
function card(over: Partial<BoardCard>): BoardCard {
  seq += 1
  return {
    id: `c${seq}`,
    card_id: `cat${seq}`,
    name: 'Test Card',
    is_tapped: false,
    damage_marked: 0,
    position_x: 0,
    position_y: 0,
    zone: 'battlefield' as BoardCard['zone'],
    image_url: null,
    type_line: 'Creature — Test',
    ...over,
  }
}
const land = (over: Partial<BoardCard> = {}) => card({ name: 'Forest', type_line: 'Basic Land — Forest', ...over })

test('plain lands collapse into the chip counts and produce no tiles', () => {
  const p = partitionSpotlightCards([land(), land(), land({ is_tapped: true })])
  assert.equal(p.tiles.length, 0)
  assert.equal(p.landTotal, 3)
  assert.equal(p.landOpen, 2)
})

test('badged lands stay as tiles but still count in the chip', () => {
  const animated = land({ animated: true })
  const damaged = land({ damage_marked: 2 })
  const aura = card({ name: 'Utopia Sprawl', type_line: 'Enchantment — Aura', attached_to: 'host-land' })
  const host = land({ id: 'host-land' })
  const p = partitionSpotlightCards([animated, damaged, host, aura, land()])
  // animated + damaged + enchanted host stay; the aura itself stays (attached);
  // the last plain Forest collapses.
  assert.deepEqual(p.tiles.map((t) => t.card.id), [animated.id, damaged.id, 'host-land', aura.id])
  assert.equal(p.landTotal, 4)
})

test('identical plain duplicates stack with a count, split by tapped state', () => {
  const a = card({ name: 'Soldier Token', is_token: true })
  const b = card({ name: 'Soldier Token', is_token: true })
  const tapped = card({ name: 'Soldier Token', is_token: true, is_tapped: true })
  const p = partitionSpotlightCards([a, b, tapped])
  assert.equal(p.tiles.length, 2)
  assert.deepEqual(p.tiles[0], { card: a, count: 2 })
  assert.deepEqual(p.tiles[1], { card: tapped, count: 1 })
})

test('cards with counters, damage, attachments or face-down never stack', () => {
  const pumped = card({ name: 'Bear', plus_one_counters: 1 })
  const plain = card({ name: 'Bear' })
  const quest = card({ name: 'Shrine', counters: { charge: 3 } })
  const shrine = card({ name: 'Shrine' })
  const down = card({ name: 'Morph', is_face_down: true })
  const down2 = card({ name: 'Morph', is_face_down: true })
  const p = partitionSpotlightCards([pumped, plain, quest, shrine, down, down2])
  assert.equal(p.tiles.length, 6)
  assert.ok(p.tiles.every((t) => t.count === 1))
})

test('legendary permanents (commander guard) never stack', () => {
  const cmdr = card({ name: 'Yshtola', type_line: 'Legendary Creature — Human Wizard' })
  const copy = card({ name: 'Yshtola', type_line: 'Legendary Creature — Human Wizard' })
  const p = partitionSpotlightCards([cmdr, copy])
  assert.equal(p.tiles.length, 2)
})

test('order is preserved and a stack sits at its first copy', () => {
  const bear1 = card({ name: 'Bear' })
  const elf = card({ name: 'Elf' })
  const bear2 = card({ name: 'Bear' })
  const p = partitionSpotlightCards([bear1, elf, bear2])
  assert.deepEqual(p.tiles.map((t) => [t.card.name, t.count]), [['Bear', 2], ['Elf', 1]])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- unit/spotlight-fit`
Expected: FAIL — `partitionSpotlightCards` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `lib/game/spotlight-fit.ts`:

```ts
import type { BoardCard } from './types'

export type SpotlightTile = { card: BoardCard; count: number }
export type SpotlightPartition = { tiles: SpotlightTile[]; landTotal: number; landOpen: number }

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
  const isPlain = (c: BoardCard) =>
    !hasBadge(c) &&
    (c.plus_one_counters ?? 0) === 0 &&
    !Object.values(c.counters ?? {}).some((n) => n > 0) &&
    !c.is_face_down &&
    !typeOf(c).includes('legendary')

  const lands = cards.filter((c) => typeOf(c).includes('land'))
  const tiles: SpotlightTile[] = []
  const stackByKey = new Map<string, SpotlightTile>()
  for (const c of cards) {
    if (typeOf(c).includes('land') && !hasBadge(c)) continue // → chip
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
```

Move the `import type { BoardCard } from './types'` line to the top of the file (imports before the Task 1 function).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- unit/spotlight-fit`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/game/spotlight-fit.ts tests/unit/spotlight-fit.test.ts
git commit -m "feat(board): partitionSpotlightCards — lands chip counts + xN duplicate stacking

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Wire into GameBoard — height lock, chip, stacks, ResizeObserver

**Files:**
- Modify: `components/GameBoard.tsx` (root div ~line 149, spotlight branch ~line 186, `FocusSeatPanel` ~lines 296–399)

**Interfaces:**
- Consumes: `fitCardColumns` and `partitionSpotlightCards` from `@/lib/game/spotlight-fit` (Tasks 1–2).
- Produces: no new exports — internal UI wiring only.

No unit test (presentational); verified by lint + typecheck + full suite + visual check in Task 4.

- [ ] **Step 1: Add imports and the fit hook**

In `components/GameBoard.tsx`, add to the imports:

```ts
import { fitCardColumns, partitionSpotlightCards } from '@/lib/game/spotlight-fit'
```

Below the imports (above `export default function GameBoard`), add:

```ts
// Card gap inside the spotlight grid — must match the Tailwind gap-3 (12px)
// on the fit container so fitCardColumns' math matches what CSS renders.
const SPOTLIGHT_GAP_PX = 12

// Measured column fit: a ResizeObserver on the card zone feeds the pure
// fitCardColumns; starts at the old static column count (5) so the first
// paint before measurement doesn't flash a different layout.
function useFitColumns(count: number) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [cols, setCols] = useState(5)
  useEffect(() => {
    const el = ref.current
    if (!el || count === 0) return
    const measure = () => {
      const rect = el.getBoundingClientRect()
      setCols(fitCardColumns(rect.width, rect.height, count, SPOTLIGHT_GAP_PX))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [count])
  return { ref, cols }
}
```

(`useRef`, `useState`, `useEffect` are already imported.)

- [ ] **Step 2: Lock the root height in spotlight mode only**

The root div (~line 149) currently has `min-h-[calc(100vh-5.75rem)]` and `[@media(max-height:640px)]:min-h-[calc(100svh-4.5rem)]` in its `className` template literal. Replace those height classes with a `viewMode`-conditional block:

```tsx
<div ref={boardRef} className={`relative isolate overflow-hidden p-4 [perspective:1600px] [@media(max-height:640px)]:p-2 sm:p-6 ${
  viewMode === 'spotlight'
    ? (tvMode
        ? 'h-[100svh]'
        : 'h-[calc(100svh-5.75rem)] [@media(max-height:640px)]:h-[calc(100svh-4.5rem)]')
    : 'min-h-[calc(100vh-5.75rem)] [@media(max-height:640px)]:min-h-[calc(100svh-4.5rem)]'
} ${tvMode ? 'tv-flat' : ''}`}>
```

Notes: the grid branch keeps today's exact `min-h` values; TV mode (no `GameViewHeader`) locks to the full viewport; member mode subtracts the same 5.75rem/4.5rem header offsets the old `min-h` already used.

- [ ] **Step 3: Make the spotlight branch fill that height**

Spotlight `motion.div` (~line 186): replace `min-h-[72vh]` with `h-full min-h-0` and drop the `[@media(max-height:640px)]:min-h-[calc(100svh-8rem)]` entry (the parent now sets the height):

```
className="relative z-20 grid h-full min-h-0 gap-5 [transform-style:preserve-3d] [@media(max-height:640px)]:grid-cols-[minmax(0,1fr)_7.5rem_minmax(9rem,11rem)] [@media(max-height:640px)]:gap-2 xl:grid-cols-[minmax(0,1fr)_10.5rem_minmax(16rem,20rem)] 2xl:gap-8 2xl:grid-cols-[minmax(0,1fr)_11rem_minmax(18rem,22rem)]"
```

The right-hand minimap aside (`motion.aside`, ~line 190) gets `min-h-0 overflow-hidden` added so a long opponent list can't push the page either:

```
className="grid min-h-0 content-start gap-3 overflow-hidden [@media(max-height:640px)]:gap-2"
```

- [ ] **Step 4: Rework `FocusSeatPanel`**

In `FocusSeatPanel` (~line 296):

a. The component already starts with `const { countByHost, nameById } = seatAttachments(seat.cards)` — keep that line and add directly below it:

```ts
const partition = useMemo(() => partitionSpotlightCards(seat.cards), [seat.cards])
const { ref: fitRef, cols } = useFitColumns(partition.tiles.length)
```

(`useMemo` is already imported in the file.)

b. Section element: replace `min-h-[32rem]` (and its `[@media(max-height:640px)]:min-h-[calc(100svh-8rem)]` variant) with a flex column that fills the branch height:

```
className={`leyline-glass-panel relative z-10 flex h-full min-h-0 flex-col overflow-hidden rounded-lg p-4 [transform:rotateX(5deg)_translateZ(0)] [transform-origin:center_bottom] [transform-style:preserve-3d] [@media(max-height:640px)]:p-3 ${ seat.isPriority ? 'leyline-priority-panel mtg-priority-border' : '' }`}
```

c. Lands chip in the header: next to the existing Phase box (inside the `flex items-center gap-3` div, before the Phase box), add:

```tsx
{partition.landTotal > 0 && (
  <div className="rounded-md border border-white/15 bg-slate-950/70 px-3 py-2 text-right">
    <p className="text-[10px] uppercase text-cyan-200/80">Lands</p>
    <p className="text-sm font-bold text-white">
      {partition.landTotal}
      {partition.landOpen > 0 ? <span className="text-emerald-300"> · {partition.landOpen} open</span> : null}
    </p>
  </div>
)}
```

d. Card zone: wrap the cards grid in a measured, flex-filling container and drive the columns inline (Tailwind cannot express a dynamic count). Replace the current `motion.div layout` grid (~line 364, `grid grid-cols-2 gap-3 ... sm:grid-cols-3 xl:grid-cols-5`) with:

```tsx
<div ref={fitRef} className="relative min-h-0 flex-1">
  <motion.div
    layout
    className="grid gap-3 justify-items-center [transform:translateZ(34px)]"
    style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
  >
    <AnimatePresence initial={false}>
      {partition.tiles.map((tile) => (
        <motion.div key={tile.card.id} layout className="relative w-full max-w-40">
          <MotionCard
            card={{
              id: tile.card.id,
              name: tile.card.name,
              image_url: tile.card.image_url,
              is_tapped: tile.card.is_tapped,
              damage_marked: tile.card.damage_marked,
              zone: tile.card.zone,
            }}
            size="board"
            className="[transform:translateZ(14px)]"
            visualClassName="shadow-[0_16px_26px_rgba(0,0,0,0.42)]"
          />
          <BoardCardBadges
            card={tile.card}
            attachmentCount={countByHost.get(tile.card.id) ?? 0}
            hostName={tile.card.attached_to ? nameById.get(tile.card.attached_to) ?? null : null}
          />
          {tile.count > 1 && (
            <span
              className="absolute -bottom-1 -right-1 z-10 rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-black text-slate-900 shadow ring-1 ring-black/40"
              title={`${tile.count} copies`}
            >
              ×{tile.count}
            </span>
          )}
        </motion.div>
      ))}
    </AnimatePresence>
  </motion.div>
</div>
```

Notes: the `max-w-40` cap moves from `MotionCard` to the tile wrapper — small boards keep today's card size (centered in wider cells via `justify-items-center`); the fit math is conservative there (it assumes full cell width), so the true rendered height only ever comes out SMALLER — the fit guarantee holds. The old `[@media(max-height:640px)]:max-w-20` and `grid-cols-*` classes disappear: the computed count replaces them. Gap is always `gap-3` (= `SPOTLIGHT_GAP_PX`); the old 640px `gap-2` variant is dropped for the same reason.

e. Empty state (~line 393): keep the `seat.cards.length === 0` placeholder exactly as is. (A board of only plain lands shows the chip and an empty card zone — correct.)

- [ ] **Step 5: Lint, typecheck, full test suite**

Run: `npx eslint .`
Expected: clean (CI runs this — see commit c5cc876).

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm test`
Expected: all suites pass (no engine tests touch GameBoard, but run the lot — it's the project's gate).

- [ ] **Step 6: Commit**

```bash
git add components/GameBoard.tsx
git commit -m "feat(board): spotlight panel always fits the viewport — lands chip, xN stacks, computed columns

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Visual verification + OpenWolf bookkeeping

**Files:**
- Modify: `.wolf/anatomy.md`, `.wolf/memory.md`

**Interfaces:**
- Consumes: the running app (Tasks 1–3 merged).
- Produces: verification evidence + updated OpenWolf indexes.

- [ ] **Step 1: Visual check with a busy board**

Success criterion (from the spec): on `/board/[id]` in spotlight mode with 30+ permanents, **no vertical scrollbar** and every nonland, non-stacked permanent individually visible.

Run: `openwolf designqc --routes /board/<session-id>` (auto-detects/starts the dev server), then Read the captured screenshots from `.wolf/designqc-captures/`.

Use an existing session from the local dev DB (`supabase` local, port 54322) — **inspect only; never delete or reset rows, this DB is Jordy's real test environment.** Find a session id via:

```sql
select session_id, count(*) from game_cards where zone = 'battlefield' group by session_id order by count(*) desc limit 5;
```

(psql: `psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c "..."`). If no session has a big battlefield, report that to Jordy and ask him to load one of his test decks instead of seeding data yourself.

- [ ] **Step 2: Check both viewport shapes**

The captures must include a normal desktop viewport and, if designqc supports it, a low-height one (`max-height:640px` media variant). Confirm: header chip visible, no scrollbar, no clipped bottom row.

- [ ] **Step 3: OpenWolf bookkeeping**

Append to `.wolf/anatomy.md` under `## lib/` (or the closest matching section):

```
- `lib/game/spotlight-fit.ts` — Pure spotlight-board fit helpers: fitCardColumns (computed column count, aspect 2:3) + partitionSpotlightCards (lands→chip counts, ×N duplicate stacking, legendary/badge guards) (~700 tok)
- `tests/unit/spotlight-fit.test.ts` — Unit tests for fitCardColumns (fit guarantee, monotonicity, give-up floor) and partitionSpotlightCards (chip counts, stacking rules) (~900 tok)
```

Append to `.wolf/memory.md`:

```
| HH:MM | Implemented spotlight viewport fit (plan 2026-07-28) — fit math, partition, GameBoard wiring, designqc verified | lib/game/spotlight-fit.ts, components/GameBoard.tsx | tests+lint green, no scrollbar at 30+ permanents | ~Nk |
```

- [ ] **Step 4: Commit**

```bash
git add .wolf/anatomy.md .wolf/memory.md
git commit -m "chore(wolf): log spotlight viewport-fit implementation + anatomy entries

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
