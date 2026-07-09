// Binder-themed loading skeletons. Server-safe (no hooks) so the route-level
// loading.tsx files can render them instantly while the page fetches. Shapes
// mirror the real components (pockets, deckboxes, stat bar) so nothing jumps
// when the content lands.

const SKEL_BG = '#2e313a'

export function Skel({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg ${className}`} style={{ background: SKEL_BG }} />
}

export function SkelStatbar() {
  return (
    <div className="flex flex-wrap gap-6">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i}>
          <Skel className="h-6 w-20" />
          <Skel className="mt-1.5 h-3 w-14" />
        </div>
      ))}
    </div>
  )
}

export function SkelPockets({ count = 8, cols = 'grid-cols-3 sm:grid-cols-5 lg:grid-cols-8' }: { count?: number; cols?: string }) {
  return (
    <div className={`grid gap-3 ${cols}`}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="bnd-pocket animate-pulse" style={{ background: SKEL_BG }} />
      ))}
    </div>
  )
}

export function SkelDeckboxes({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="bnd-deckbox animate-pulse" style={{ borderLeftColor: '#383b45' }}>
          <div className="h-11 w-11 rounded-full" style={{ background: SKEL_BG, position: 'absolute', top: 14, right: 14 }} />
          <Skel className="h-5 w-36" />
          <Skel className="mt-2 h-3 w-24" />
          <Skel className="mt-3 h-5 w-28" />
        </div>
      ))}
    </div>
  )
}

export function SkelRows({ count = 3, height = 'h-20' }: { count?: number; height?: string }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, i) => (
        <Skel key={i} className={`${height} w-full`} />
      ))}
    </div>
  )
}

/** Full-page shell for route-level loading.tsx files. */
export function PageSkeleton({ children, hint }: { children: React.ReactNode; hint: string }) {
  return (
    <div className="binder-shell min-h-screen" role="status" aria-label={hint}>
      {/* nav placeholder keeps the header height stable */}
      <div className="flex items-center gap-2 px-5 py-3" style={{ borderBottom: '1px solid #26282f' }}>
        <div className="mx-auto flex w-full max-w-5xl items-center gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skel key={i} className="h-8 w-24" />
          ))}
        </div>
      </div>
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <Skel className="h-8 w-64" />
        <Skel className="mt-2 h-4 w-96 max-w-full" />
        <p className="sr-only">{hint}</p>
        <div className="mt-8 space-y-8">{children}</div>
      </main>
    </div>
  )
}

/** The deck page's client-side scan skeleton (gauge + composition + rows). */
export function DeckScanSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Analysing deck">
      <div className="grid gap-4 md:grid-cols-[auto_1fr]">
        <div className="bnd-deckbox flex items-center gap-5 p-6" style={{ borderLeftColor: '#383b45' }}>
          <div className="h-24 w-24 shrink-0 animate-pulse rounded-full" style={{ background: SKEL_BG }} />
          <div>
            <Skel className="h-4 w-40" />
            <Skel className="mt-2 h-3 w-56" />
            <Skel className="mt-1.5 h-3 w-48" />
          </div>
        </div>
        <Skel className="min-h-32 w-full" />
      </div>
      <div className="flex gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skel key={i} className="h-9 w-24" />
        ))}
      </div>
      <SkelRows count={3} height="h-24" />
      <p className="font-rules text-xs" style={{ color: 'var(--text-faint)' }}>
        Scoring the deck and scanning your binder for upgrades…
      </p>
    </div>
  )
}
