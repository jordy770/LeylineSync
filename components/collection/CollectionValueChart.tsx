'use client'

import { useRef, useState } from 'react'

// Collection value over time — one point per import snapshot (mig 381) plus a
// live "now" point. Single series: the gold brand line carries identity (the
// panel title names it, so no legend), text stays in text tokens, the grid is
// recessive. Hover/tap shows a crosshair + tooltip with the exact point.

export interface ValuePoint {
  date: string
  valueEur: number
}

const W = 600
const H = 190
const PX = 8
const PY = 14
const MAX_DOTS = 24

function euro(v: number): string {
  return `€${Math.round(v).toLocaleString('en-US')}`
}

export function CollectionValueChart({ points }: { points: ValuePoint[] }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState<number | null>(null)

  if (points.length < 2) return null

  const ts = points.map((p) => Date.parse(p.date))
  const vs = points.map((p) => p.valueEur)
  const tMin = Math.min(...ts)
  const tMax = Math.max(...ts)
  let vMin = Math.min(...vs)
  let vMax = Math.max(...vs)
  if (vMax === vMin) {
    vMax += 1
    vMin = Math.max(0, vMin - 1)
  }
  const pad = (vMax - vMin) * 0.08
  vMax += pad
  vMin = Math.max(0, vMin - pad)

  const x = (t: number) => PX + ((t - tMin) / Math.max(1, tMax - tMin)) * (W - PX * 2)
  const y = (v: number) => PY + (1 - (v - vMin) / (vMax - vMin)) * (H - PY * 2)
  const coords = points.map((p, i) => [x(ts[i]), y(vs[i])] as const)
  const line = coords.map(([cx, cy], i) => `${i ? 'L' : 'M'}${cx.toFixed(1)},${cy.toFixed(1)}`).join(' ')
  const area = `${line} L${coords[coords.length - 1][0].toFixed(1)},${H - PY} L${coords[0][0].toFixed(1)},${H - PY} Z`

  function onMove(e: React.PointerEvent) {
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    const gx = ((e.clientX - rect.left) / rect.width) * W
    let best = 0
    for (let i = 1; i < coords.length; i += 1) {
      if (Math.abs(coords[i][0] - gx) < Math.abs(coords[best][0] - gx)) best = i
    }
    setActive(best)
  }

  const a = active != null ? coords[active] : null

  return (
    <div>
      <div
        ref={wrapRef}
        className="relative"
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setActive(null)}
      >
        {/* Scale extremes — quiet, in text tokens, out of the data's way. */}
        <span className="pointer-events-none absolute left-1 top-0 text-[10px]" style={{ color: 'var(--text-faint)' }}>
          {euro(vMax)}
        </span>
        <span className="pointer-events-none absolute bottom-0 left-1 text-[10px]" style={{ color: 'var(--text-faint)' }}>
          {euro(vMin)}
        </span>

        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="Collection value over time">
          {/* Recessive grid */}
          {[0.25, 0.5, 0.75].map((f) => (
            <line
              key={f}
              x1={PX}
              x2={W - PX}
              y1={PY + f * (H - PY * 2)}
              y2={PY + f * (H - PY * 2)}
              stroke="rgba(201,154,58,0.10)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}

          <path d={area} fill="rgba(201,154,58,0.10)" />
          <path d={line} fill="none" stroke="var(--gold-bright)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />

          {points.length <= MAX_DOTS
            ? coords.map(([cx, cy], i) => (
                <circle key={i} cx={cx} cy={cy} r={3} fill="var(--gold-bright)" stroke="var(--ink-2)" strokeWidth={1.5} />
              ))
            : null}

          {a ? (
            <>
              <line x1={a[0]} x2={a[0]} y1={PY} y2={H - PY} stroke="rgba(201,154,58,0.35)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
              <circle cx={a[0]} cy={a[1]} r={4.5} fill="var(--gold-bright)" stroke="var(--ink-2)" strokeWidth={2} />
            </>
          ) : null}
        </svg>

        {a && active != null ? (
          <div
            className="pointer-events-none absolute z-10 rounded-lg px-2.5 py-1.5 text-xs shadow-xl"
            style={{
              left: `${(a[0] / W) * 100}%`,
              top: `${(a[1] / H) * 100}%`,
              transform: `translate(${a[0] > W * 0.75 ? '-105%' : a[0] < W * 0.25 ? '5%' : '-50%'}, -130%)`,
              background: 'var(--ink-2)',
              border: '1px solid rgba(201,154,58,0.35)',
              color: 'var(--text)',
            }}
          >
            <span className="font-display">{euro(points[active].valueEur)}</span>
            <span style={{ color: 'var(--text-faint)' }}> · {points[active].date.slice(0, 10)}</span>
          </div>
        ) : null}
      </div>

      <div className="mt-1 flex justify-between text-[10px]" style={{ color: 'var(--text-faint)' }}>
        <span>{points[0].date.slice(0, 10)}</span>
        <span>{points[points.length - 1].date.slice(0, 10)}</span>
      </div>
    </div>
  )
}
