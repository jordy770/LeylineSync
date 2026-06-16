'use client'

/**
 * HandFan — MTG Arena-style hand for the mobile controller.
 *
 * Gestures (all framer-motion):
 *   - Collapsed: tap the fan to raise it; tap outside to retract.
 *   - Expanded + mouse hover: cards pop as the pointer passes (desktop browse).
 *   - Drag a card sideways → reorder (neighbours open a gap).
 *   - Drag a card up into the cast zone → play it (host-driven via `onCast`).
 *   - Tap a card (no drag) → open its details.
 *   - Press & hold a card → peek (host-driven via `onHold`).
 *
 * Playability: pass `playable` + `showPlayability` per card to get the Arena
 * "castable" amber ring / dimmed-when-unplayable cues (calm hand off-window).
 *
 * Each card (FanCard) is two nested motion layers:
 *   outer = slot position (animates on index change → smooth reorder),
 *   inner = the grab layer, dragging its own x/y motion values which we
 *           explicitly spring back to 0 on release. Owning the offset (rather
 *           than dragSnapToOrigin) means a fast "throw" + reorder can't strand
 *           a card with a leftover transform.
 *
 * Self-contained prototype. Reuses the shared MotionCard visual.
 */

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  type PanInfo,
} from 'framer-motion'
import MotionCard from '@/components/MotionCard'
import { cn } from '@/lib/utils'
import { useLongPress } from '@/lib/game/use-long-press'

/** Pointer-handler bundle returned by useLongPress's bind factory. */
type PeekProps = ReturnType<ReturnType<typeof useLongPress>>

export type HandFanCard = {
  id: string
  name: string | null
  image_url?: string | null
  /** Castable / playable right now (mana + timing). Drives the amber ring. */
  playable?: boolean
  /** Apply the playable/dim cues at all — i.e. it's a priority window for this
   *  card. When false the card renders plainly ("calm hand" off-turn). */
  showPlayability?: boolean
}

type HandFanProps = {
  cards: HandFanCard[]
  /** Fired when a card is tapped. Also opens the built-in zoom unless
   *  `tapOpensZoom` is false. */
  onSelect?: (card: HandFanCard) => void
  /** Fired when a card is pressed & held — for a "peek" (read the full card).
   *  When omitted, no long-press is attached. */
  onHold?: (card: HandFanCard) => void
  /** Fired when a card is dragged up into the cast zone. When omitted, the cast
   *  zone is disabled (dragging up just returns the card to the fan). */
  onCast?: (card: HandFanCard) => void
  /** Open the built-in zoom pop-over on tap (default). Turn off to delegate
   *  entirely to `onSelect` (e.g. to open a host action sheet). */
  tapOpensZoom?: boolean
}

// --- fan geometry ----------------------------------------------------------
const SLOT_X = 52 // px between card centres at rest (cards overlap)
const ANGLE = 4 // deg of rotation per step from centre
const ARC = 7 // px the edge cards dip below the centre
const COLLAPSED_Y = 96 // px the whole fan drops when collapsed
const POP_Y = 48 // px the hovered card lifts
const PUSH = 26 // px the immediate neighbour is shoved aside
const CAST_LINE = 0.55 // drag a card above this fraction of viewport height to cast
const CARD_W = 84 // px card width (must match the className width)
const CARD_HALF = CARD_W / 2 // centring offset baked into the animated x
const HYST = 0.22 // deadband (in slots) past a midpoint before the gap re-commits

const SLOT_SPRING = { type: 'spring', stiffness: 520, damping: 34, mass: 0.6 } as const
const RETURN_SPRING = { type: 'spring', stiffness: 480, damping: 38 } as const

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** Same cards in the same order with the same display data? (avoids re-renders) */
function sameHand(a: HandFanCard[], b: HandFanCard[]) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.id !== y.id ||
      x.playable !== y.playable ||
      x.showPlayability !== y.showPlayability ||
      x.name !== y.name ||
      x.image_url !== y.image_url
    ) {
      return false
    }
  }
  return true
}

type DragEvt = MouseEvent | TouchEvent | PointerEvent

type SlotTransform = { x: number; y: number; rotate: number; scale: number }

/** Resting fan transform for slot `i` of `n`. */
function restingSlot(i: number, n: number) {
  const mid = (n - 1) / 2
  const off = i - mid
  return {
    x: off * SLOT_X,
    y: Math.abs(off) ** 1.5 * ARC,
    rotate: off * ANGLE,
  }
}

// --- one card --------------------------------------------------------------
type FanCardProps = {
  card: HandFanCard
  outer: SlotTransform
  zIndex: number
  draggable: boolean
  isDragging: boolean
  ringed: boolean
  dimmed: boolean
  peekProps?: PeekProps
  onTapCard: () => void
  onDragStart: () => void
  onDrag: (e: DragEvt, info: PanInfo) => void
  onDragEnd: () => void
}

function FanCard({
  card,
  outer,
  zIndex,
  draggable,
  isDragging,
  ringed,
  dimmed,
  peekProps,
  onTapCard,
  onDragStart,
  onDrag,
  onDragEnd,
}: FanCardProps) {
  // Inner grab offset — we own these so we can always spring them home.
  const dx = useMotionValue(0)
  const dy = useMotionValue(0)
  // True once a drag has started, so the click the browser fires after the
  // release can be swallowed (a drag-to-cast / reorder must NOT also tap-open).
  // Reset on every fresh press so a later genuine tap still registers.
  const draggedRef = useRef(false)

  // Whenever this card is NOT being dragged, force the grab offset back to its
  // slot. Tying the reset to the React state transition (not just framer's
  // onDragEnd) guarantees the card slides home even after a fast release.
  useEffect(() => {
    if (isDragging) return
    const a = animate(dx, 0, RETURN_SPRING)
    const b = animate(dy, 0, RETURN_SPRING)
    return () => {
      a.stop()
      b.stop()
    }
  }, [isDragging, dx, dy])

  return (
    <motion.div
      className="absolute bottom-0 left-0 w-[84px] origin-bottom"
      style={{ zIndex }}
      initial={false}
      animate={outer}
      exit={{ scale: 1.4, y: -180, opacity: 0 }}
      transition={SLOT_SPRING}
    >
      <motion.div
        {...peekProps}
        onPointerDown={(e) => {
          draggedRef.current = false
          peekProps?.onPointerDown?.(e)
        }}
        drag={draggable}
        dragMomentum={false}
        dragElastic={0.4}
        style={{ x: dx, y: dy }}
        onDragStart={() => {
          draggedRef.current = true
          onDragStart()
        }}
        onDrag={onDrag}
        onDragEnd={onDragEnd}
        onClick={(e) => {
          e.stopPropagation()
          if (draggedRef.current) {
            draggedRef.current = false
            return // this click is the tail of a drag — ignore it
          }
          onTapCard()
        }}
        className={cn(
          'cursor-grab touch-none rounded-lg transition-opacity active:cursor-grabbing',
          ringed && 'ring-1 ring-amber-400/80 ring-offset-1 ring-offset-[#0C0E14]',
          dimmed && 'opacity-40',
        )}
      >
        <MotionCard
          card={{ id: card.id, name: card.name, image_url: card.image_url, zone: 'hand' }}
          size="board"
          useLayoutId={false}
        />
      </motion.div>
    </motion.div>
  )
}

export default function HandFan({
  cards,
  onSelect,
  onHold,
  onCast,
  tapOpensZoom = true,
}: HandFanProps) {
  const canCast = Boolean(onCast)
  const [expanded, setExpanded] = useState(false)
  const [active, setActive] = useState<number | null>(null) // mouse-hover pop
  const [zoomed, setZoomed] = useState<HandFanCard | null>(null)
  const fanRef = useRef<HTMLDivElement>(null)
  // One long-press instance serves every card; a >10px move (i.e. a drag)
  // cancels the press, and the post-press click is swallowed for us. 250ms hold
  // (snappier than the 350ms default) is scoped to the fan only.
  const bindPeek = useLongPress()

  // Local order so the prototype can reorder / cast without a parent round-trip.
  const [hand, setHand] = useState<HandFanCard[]>(cards)

  // Drag state.
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [castArmed, setCastArmed] = useState(false) // dragged up into the cast zone
  // Mirrors read inside the high-frequency drag handler / on drag end, so we
  // compare against the latest value, not a stale render.
  const dropRef = useRef<number | null>(null)
  const castRef = useRef(false)

  // Reconcile the local hand with incoming props: keep the player's arrangement
  // (match by id) and just refresh each card's data, append new cards, drop gone
  // ones. This stops a background refresh — whose server-side order can differ
  // (e.g. tied zone_position) — from reshuffling the fan or showing stale cues.
  // Skip while dragging so a realtime tick can't yank a card mid-gesture.
  useEffect(() => {
    if (dragFrom !== null) return
    setHand((prev) => {
      const byId = new Map(cards.map((c) => [c.id, c] as const))
      const kept = prev.flatMap((c) => {
        const fresh = byId.get(c.id)
        return fresh ? [fresh] : []
      })
      const keptIds = new Set(kept.map((c) => c.id))
      const added = cards.filter((c) => !keptIds.has(c.id))
      const next = [...kept, ...added]
      return sameHand(prev, next) ? prev : next
    })
  }, [cards, dragFrom])

  const n = hand.length

  // --- hover hit-test (desktop mouse only) --------------------------------
  function handlePointerMove(e: ReactPointerEvent) {
    if (!expanded || dragFrom !== null) return
    if (e.pointerType === 'touch') return // touch "move" is a drag, handled per-card
    const el = fanRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const px = e.clientX - (rect.left + rect.width / 2)
    const mid = (n - 1) / 2
    setActive(clamp(Math.round(px / SLOT_X + mid), 0, n - 1))
  }

  // --- drag (reorder + cast) ----------------------------------------------
  function handleDrag(_e: DragEvt, info: PanInfo) {
    // Dragged up into the cast zone → arm cast, suspend reorder.
    if (canCast) {
      const vh = typeof window !== 'undefined' ? window.innerHeight : 800
      const arming = info.point.y < vh * CAST_LINE
      if (arming !== castRef.current) {
        castRef.current = arming
        setCastArmed(arming)
      }
      if (arming) {
        setDropIndex(null)
        dropRef.current = null
        return
      }
    }
    const el = fanRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const px = info.point.x - (rect.left + rect.width / 2)
    const mid = (n - 1) / 2
    const f = px / SLOT_X + mid // fractional slot under the finger

    // Hysteresis: only step the gap once the finger clears the neighbouring
    // slot's midpoint by HYST. Loops so a fast flick can jump several slots.
    let d = dropRef.current ?? dragFrom ?? Math.round(f)
    while (d < n - 1 && f > d + 0.5 + HYST) d++
    while (d > 0 && f < d - 0.5 - HYST) d--
    d = clamp(d, 0, n - 1)
    dropRef.current = d
    setDropIndex(d)
  }

  function handleDragEnd(i: number) {
    const card = hand[i]
    if (castRef.current && card) {
      onCast?.(card) // released in the cast zone → play it
    } else if (dropIndex !== null && dropIndex !== i) {
      setHand((h) => {
        const next = [...h]
        const [moved] = next.splice(i, 1)
        next.splice(dropIndex, 0, moved)
        return next
      })
    }
    setDragFrom(null)
    setDropIndex(null)
    dropRef.current = null
    castRef.current = false
    setCastArmed(false)
  }

  /**
   * Slot a card occupies while a drag opens a gap at `dropIndex`.
   * The dragged card keeps a FIXED anchor (its start slot) so the inner drag
   * layer tracks the finger exactly — it's lifted away by the drag offset, so
   * the finger covers the real gap. The other n-1 cards fill the remaining
   * slots, leaving `to` open.
   */
  function visualIndex(i: number) {
    if (dragFrom === null) return i
    const to = dropIndex ?? dragFrom
    if (i === dragFrom) return dragFrom
    const rank = i < dragFrom ? i : i - 1
    return rank < to ? rank : rank + 1
  }

  function openCard(card: HandFanCard) {
    setZoomed(card)
    onSelect?.(card)
  }

  // Activate = open details: built-in zoom (default) or delegate to the host.
  function activate(card: HandFanCard) {
    if (tapOpensZoom) openCard(card)
    else onSelect?.(card)
  }

  return (
    <>
      {/* Cast zone — appears while dragging a card (only if onCast is wired) */}
      <AnimatePresence>
        {canCast && dragFrom !== null && (
          <motion.div
            className="pointer-events-none fixed inset-x-0 top-[18%] z-20 flex justify-center"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
          >
            <motion.div
              animate={{
                scale: castArmed ? 1.06 : 1,
                borderColor: castArmed ? 'rgba(251,191,36,0.95)' : 'rgba(148,163,184,0.4)',
                backgroundColor: castArmed ? 'rgba(251,191,36,0.12)' : 'rgba(12,14,20,0.5)',
              }}
              className="flex h-28 w-44 items-center justify-center rounded-2xl border-2 border-dashed text-center"
            >
              <span
                className={`text-xs font-black uppercase tracking-widest ${
                  castArmed ? 'text-amber-300' : 'text-slate-500'
                }`}
              >
                {castArmed ? 'Release to play' : 'Drag up to play'}
              </span>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Tap-outside-to-collapse backdrop (only while expanded). Sits below the
          fan (z-30) so taps on the cards hit the cards, not this. */}
      {expanded && (
        <div
          className="fixed inset-0 z-20"
          onClick={() => {
            setExpanded(false)
            setActive(null)
          }}
        />
      )}

      {/* Bottom-pinned fan panel */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center">
        <motion.div
          ref={fanRef}
          className="pointer-events-auto relative h-[210px] w-full max-w-md touch-none select-none"
          animate={{ y: expanded ? 0 : COLLAPSED_Y }}
          transition={{ type: 'spring', stiffness: 320, damping: 32 }}
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setActive(null)}
          onPointerUp={() => setActive(null)}
          onClick={() => {
            if (!expanded) setExpanded(true)
          }}
        >
          {/* Cards, anchored bottom-centre so rotation fans them out */}
          <div className="absolute bottom-3 left-1/2 h-[150px] w-0">
            <AnimatePresence>
              {hand.map((card, i) => {
                const isDragged = dragFrom === i
                const slot = restingSlot(visualIndex(i), n)

                // Mouse-hover pop / neighbour push (only when not dragging).
                let pushX = 0
                let popped = false
                if (dragFrom === null && active !== null) {
                  if (active === i) popped = true
                  else {
                    const dist = i - active
                    pushX = Math.sign(dist) * Math.max(0, PUSH - (Math.abs(dist) - 1) * 12)
                  }
                }

                const outer: SlotTransform = {
                  x: slot.x + pushX - CARD_HALF,
                  y: popped ? -POP_Y : slot.y,
                  rotate: isDragged || popped ? 0 : slot.rotate,
                  scale: isDragged ? (castArmed ? 1.34 : 1.22) : popped ? 1.3 : 1,
                }

                const showCues = card.showPlayability ?? false

                return (
                  <FanCard
                    key={card.id}
                    card={card}
                    outer={outer}
                    zIndex={isDragged ? 100 : popped ? 50 : i}
                    draggable={expanded}
                    isDragging={isDragged}
                    ringed={showCues && (card.playable ?? false)}
                    dimmed={showCues && !(card.playable ?? false) && !isDragged}
                    peekProps={onHold && expanded ? bindPeek(() => onHold(card)) : undefined}
                    onTapCard={() => {
                      if (!expanded) {
                        setExpanded(true)
                        return
                      }
                      activate(card)
                    }}
                    onDragStart={() => {
                      setDragFrom(i)
                      setDropIndex(i)
                      dropRef.current = i
                      setActive(null)
                    }}
                    onDrag={handleDrag}
                    onDragEnd={() => handleDragEnd(i)}
                  />
                )
              })}
            </AnimatePresence>
          </div>
        </motion.div>
      </div>

      {/* Zoom / inspection pop-over */}
      <AnimatePresence>
        {zoomed && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-8 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setZoomed(null)}
          >
            <motion.div
              className="w-64 max-w-[80vw]"
              initial={{ scale: 0.7, y: 40, opacity: 0 }}
              animate={{ scale: 1, y: 0, opacity: 1 }}
              exit={{ scale: 0.7, y: 40, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 360, damping: 30 }}
              onClick={(e) => e.stopPropagation()}
            >
              <MotionCard
                card={{ id: zoomed.id, name: zoomed.name, image_url: zoomed.image_url, zone: 'hand' }}
                size="board"
                useLayoutId={false}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
