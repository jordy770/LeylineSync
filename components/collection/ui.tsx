import type { ReactNode } from 'react'

// Shared Collection UI primitives. In their OWN module (not Shell.tsx) because
// CLIENT components import these too: Shell renders the server-only SiteNav
// (AuthButton → lib/supabase/server → next/headers), which a client bundle
// must never traverse. Shell re-exports them for its server-side importers.

const MANA: Record<string, string> = { w: 'var(--mana-w)', u: 'var(--mana-u)', b: 'var(--mana-b)', r: 'var(--mana-r)', g: 'var(--mana-g)' }

/** Color-identity pips rendered as small mana-coloured dots. */
export function ColorPips({ colors }: { colors: string[] }) {
  if (!colors || colors.length === 0) {
    return (
      <span className="text-xs" style={{ color: 'var(--text-faint)' }}>
        Colorless
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1">
      {colors.map((c) => (
        <span
          key={c}
          aria-label={c}
          className="inline-block h-3 w-3 rounded-full"
          style={{ backgroundColor: MANA[c.toLowerCase()] ?? 'var(--text-faint)', boxShadow: '0 0 0 1px rgba(0,0,0,0.4) inset' }}
        />
      ))}
    </span>
  )
}

/** A glass panel matching the in-game Leyline chrome. */
export function Panel({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`leyline-glass-panel rounded-xl ${className}`}>{children}</div>
  )
}

const SPINE_COLORS: Record<string, string> = { W: '#cfc7a8', U: '#5b87c5', B: '#7e6a9c', R: '#c56b50', G: '#5e9b60' }

/** The color a deckbox spine / binder rug wears — the first mana color, gold otherwise. */
export function spineColor(colors: string[] | undefined): string {
  return SPINE_COLORS[colors?.[0]?.toUpperCase() ?? ''] ?? '#e8b44c'
}

/** A physical deckbox with a colored spine and a power dial (binder theme). */
export function Deckbox({
  name,
  sub,
  power,
  colors,
  children,
}: {
  name: string
  sub?: ReactNode
  power?: number | null
  colors?: string[]
  children?: ReactNode
}) {
  const pct = power != null ? `${Math.round(Math.max(0, Math.min(10, power)) * 10)}%` : '0%'
  return (
    <div className="bnd-deckbox" style={{ borderLeftColor: spineColor(colors) }}>
      <span className="bnd-pow" style={{ ['--p' as never]: pct }}>
        <b>{power != null ? power.toFixed(1) : '—'}</b>
      </span>
      <h3 className="font-display pr-12 text-base" style={{ color: 'var(--text-bright)' }}>
        {name}
      </h3>
      {sub ? (
        <p className="font-rules mt-1 text-xs" style={{ color: 'var(--text-dim)' }}>
          {sub}
        </p>
      ) : null}
      {children}
    </div>
  )
}
