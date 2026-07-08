'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// A card name that shows the actual card on hover — a Magic player decides on
// the image, not the name. The preview is fetched lazily from Scryfall's
// named-card endpoint (browser <img>, follows the redirect to their CDN) and
// rendered through a portal on document.body: several call sites live inside
// hover-scaled panels, and a fixed element inside a transformed ancestor would
// anchor to the panel instead of the viewport.

const IMG_W = 244
const IMG_H = 340
const GAP = 12
const HOVER_DELAY_MS = 180

export function CardName({
  name,
  className,
  style,
  children,
}: {
  name: string
  className?: string
  style?: React.CSSProperties
  children?: React.ReactNode
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const timer = useRef<number | null>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    return () => {
      if (timer.current != null) window.clearTimeout(timer.current)
    }
  }, [])

  function show() {
    if (failed) return
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    // Prefer the right of the name; clamp inside the viewport.
    const x = Math.max(GAP, Math.min(r.right + GAP, window.innerWidth - IMG_W - GAP))
    const y = Math.max(GAP, Math.min(r.top - IMG_H / 3, window.innerHeight - IMG_H - GAP))
    setPos({ x, y })
  }

  function scheduleShow() {
    if (timer.current != null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(show, HOVER_DELAY_MS)
  }

  function hide() {
    if (timer.current != null) window.clearTimeout(timer.current)
    timer.current = null
    setPos(null)
  }

  const src = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}&format=image&version=normal`

  return (
    <span
      ref={ref}
      className={className}
      style={style}
      onMouseEnter={scheduleShow}
      onMouseLeave={hide}
    >
      {children ?? name}
      {pos != null && typeof document !== 'undefined'
        ? createPortal(
            <span
              className="pointer-events-none fixed z-50 block overflow-hidden rounded-xl shadow-2xl"
              style={{ left: pos.x, top: pos.y, width: IMG_W, height: IMG_H, background: 'var(--ink-2)' }}
            >
              {/* Scryfall serves ready-made card scans; next/image adds nothing here. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src}
                alt={name}
                width={IMG_W}
                height={IMG_H}
                className="h-full w-full object-cover"
                onError={() => {
                  setFailed(true)
                  setPos(null)
                }}
              />
            </span>,
            document.body,
          )
        : null}
    </span>
  )
}
