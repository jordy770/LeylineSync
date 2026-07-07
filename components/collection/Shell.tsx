import Link from 'next/link'
import type { ReactNode } from 'react'
import FanContentNotice from '@/components/layout/FanContentNotice'
import SiteNav from '@/components/SiteNav'

// The Collection Optimizer shell — the Leyline arcane ground (void + gold + ley
// grid) with a slim header. Server-compatible (no hooks) so pages can wrap their
// server-rendered content directly.

export function Shell({
  title,
  lead,
  actions,
  children,
}: {
  title: string
  lead?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="landing-void min-h-screen" style={{ color: 'var(--text)' }}>
      {/* Same top nav as the landing and decks pages — one identity, so hopping
          between Home / Decks / Collection never changes the header. */}
      <SiteNav active="collection" />
      {/* Collection sub-nav: the section links the old bespoke header carried. */}
      <div
        className="flex items-center gap-4 overflow-x-auto px-5 py-2 text-sm"
        style={{ borderBottom: '1px solid rgba(201,154,58,0.18)' }}
      >
        <nav className="mx-auto flex w-full max-w-5xl items-center gap-4">
          <Link href="/collection" className="hover:underline" style={{ color: 'var(--text-dim)' }}>
            Overview
          </Link>
          <Link href="/collection/search" className="hover:underline" style={{ color: 'var(--text-dim)' }}>
            Find a card
          </Link>
          <Link href="/collection/import" className="hover:underline" style={{ color: 'var(--text-dim)' }}>
            Import collection
          </Link>
          <Link href="/collection/decks/import" className="hover:underline" style={{ color: 'var(--text-dim)' }}>
            Import deck
          </Link>
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
export { ColorPips, Panel } from './ui'
