import Link from 'next/link'
import { Karla, Outfit } from 'next/font/google'
import type { ReactNode } from 'react'
import FanContentNotice from '@/components/layout/FanContentNotice'
import SiteNav from '@/components/SiteNav'

// Binder-theme typography (design: mockups/collection-binder-screens.html).
const outfit = Outfit({ subsets: ['latin'], variable: '--font-outfit', weight: ['400', '500', '600', '700'] })
const karla = Karla({ subsets: ['latin'], variable: '--font-karla', weight: ['400', '500', '600', '700'] })

// The Collection Optimizer shell — the Leyline arcane ground (void + gold + ley
// grid) with a slim header. Server-compatible (no hooks) so pages can wrap their
// server-rendered content directly.

// 'import' / 'deck-import' pages exist but are reached via Overview's action
// buttons — the nav stays four places, not a mix of places and actions.
export type CollectionSection = 'overview' | 'advisor' | 'search' | 'binders' | 'import' | 'deck-import'

const SECTIONS: { key: CollectionSection; href: string; label: string }[] = [
  { key: 'overview', href: '/collection', label: 'Overview' },
  { key: 'advisor', href: '/collection/advisor', label: 'Advisor' },
  { key: 'binders', href: '/collection/binders', label: 'Binders' },
  { key: 'search', href: '/collection/search', label: 'Find a card' },
]

export function Shell({
  title,
  lead,
  actions,
  active,
  children,
}: {
  title: string
  lead?: string
  actions?: ReactNode
  /** Which section to highlight in the sub-nav. Omit on nested pages (deck detail). */
  active?: CollectionSection
  children: ReactNode
}) {
  return (
    <div className={`binder-shell min-h-screen ${outfit.variable} ${karla.variable}`} style={{ color: 'var(--text)' }}>
      {/* Same top nav as the landing and decks pages — one identity, so hopping
          between Home / Decks / Collection never changes the header. */}
      <SiteNav active="collection" />
      {/* Collection sub-nav: pill per section, the current one lit. */}
      <div className="flex items-center gap-2 overflow-x-auto px-5 py-2 text-sm" style={{ borderBottom: '1px solid #26282f' }}>
        <nav className="mx-auto flex w-full max-w-5xl items-center gap-2">
          {SECTIONS.map((s) => {
            const isActive = active === s.key
            return (
              <Link
                key={s.key}
                href={s.href}
                aria-current={isActive ? 'page' : undefined}
                className="whitespace-nowrap rounded-lg px-3 py-1.5 font-medium"
                style={isActive ? { background: '#2e313a', color: '#fff' } : { color: 'var(--text-dim)' }}
              >
                {s.label}
              </Link>
            )
          })}
        </nav>
      </div>

      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl sm:text-3xl" style={{ color: 'var(--text-bright)' }}>
              {title}
            </h1>
            {lead ? (
              <p className="font-rules mt-1 text-sm" style={{ color: 'var(--text-dim)' }}>
                {lead}
              </p>
            ) : null}
          </div>
          {actions}
        </div>
        {children}
      </main>
      <footer className="border-t py-6" style={{ borderColor: 'color-mix(in srgb, var(--frame-gold) 15%, transparent)' }}>
        <FanContentNotice />
      </footer>
    </div>
  )
}

// Re-exported for the SERVER pages that import them alongside Shell. CLIENT
// components must import from './ui' directly — importing via this module
// drags the server-only SiteNav (next/headers) into their bundle.
export { ColorPips, Panel, Deckbox, spineColor } from './ui'
