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
