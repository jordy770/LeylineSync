import Link from 'next/link'
import { redirect } from 'next/navigation'

import { ColorPips, Panel, Shell } from '@/components/collection/Shell'
import { locateCards } from '@/lib/collection/locator'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

// /collection/search?q=…&free=1&color=G&type=creature
// "Where does this card live?" — binders (with counts), decks, free copies.

const COLORS = ['W', 'U', 'B', 'R', 'G'] as const

export default async function CollectionSearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; free?: string; color?: string; type?: string }>
}) {
  const supabase = await createClient()
  const { data: claims, error } = await supabase.auth.getClaims()
  if (error || !claims?.claims?.sub) redirect('/auth/login')
  const userId = claims.claims.sub as string

  const params = await searchParams
  const q = (params.q ?? '').trim()
  const freeOnly = params.free === '1'
  const color = params.color && COLORS.includes(params.color as (typeof COLORS)[number]) ? params.color : null
  const type = (params.type ?? '').trim() || null

  const results = q ? await locateCards(supabase, userId, q, { freeOnly, color, type }) : []

  // Filter chips re-issue the same search with one param toggled.
  const chipHref = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams()
    if (q) next.set('q', q)
    if (freeOnly) next.set('free', '1')
    if (color) next.set('color', color)
    if (type) next.set('type', type)
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k)
      else next.set(k, v)
    }
    return `/collection/search?${next.toString()}`
  }

  return (
    <Shell
      title="Find a card"
      lead="Search your collection: which binder holds it, which decks claim it, and how many copies are free."
      actions={
        <Link href="/collection" className="rounded-lg px-4 py-2 text-sm" style={{ border: '1px solid rgba(201,154,58,0.4)', color: 'var(--text)' }}>
          ← Back
        </Link>
      }
    >
      <form action="/collection/search" className="mb-4 flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Card name…"
          autoFocus
          className="w-full max-w-md rounded-lg px-3 py-2 text-sm outline-none"
          style={{ border: '1px solid rgba(201,154,58,0.3)', background: 'var(--ink-2)', color: 'var(--text)' }}
        />
        {freeOnly ? <input type="hidden" name="free" value="1" /> : null}
        {color ? <input type="hidden" name="color" value={color} /> : null}
        {type ? <input type="hidden" name="type" value={type} /> : null}
        <button
          type="submit"
          className="rounded-lg px-4 py-2 text-sm font-medium"
          style={{ background: 'linear-gradient(150deg, var(--gold-bright), var(--frame-gold))', color: '#1c1407' }}
        >
          Search
        </button>
      </form>

      {q ? (
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <FilterChip href={chipHref({ free: freeOnly ? null : '1' })} active={freeOnly}>
            Free copies only
          </FilterChip>
          {COLORS.map((c) => (
            <FilterChip key={c} href={chipHref({ color: color === c ? null : c })} active={color === c}>
              {c}
            </FilterChip>
          ))}
          {['creature', 'instant', 'sorcery', 'artifact', 'enchantment', 'land'].map((t) => (
            <FilterChip key={t} href={chipHref({ type: type === t ? null : t })} active={type === t}>
              {t}
            </FilterChip>
          ))}
        </div>
      ) : null}

      {!q ? (
        <Panel className="p-6">
          <p className="font-rules text-sm" style={{ color: 'var(--text-dim)' }}>
            Type a card name to see where your copies live.
          </p>
        </Panel>
      ) : results.length === 0 ? (
        <Panel className="p-6">
          <p className="font-rules text-sm" style={{ color: 'var(--text-dim)' }}>
            Nothing in your collection matches “{q}”{freeOnly || color || type ? ' with these filters' : ''}.
          </p>
        </Panel>
      ) : (
        <div className="space-y-2">
          {results.map((card) => (
            <Panel key={card.oracleId} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-display text-base" style={{ color: 'var(--text-bright)' }}>
                    {card.name}
                  </span>
                  <ColorPips colors={card.colorIdentity} />
                  {card.typeLine ? (
                    <span className="text-xs" style={{ color: 'var(--text-faint)' }}>
                      {card.typeLine}
                    </span>
                  ) : null}
                </div>
                {card.binders.length > 0 ? (
                  <div className="mt-1 text-sm" style={{ color: 'var(--text-dim)' }}>
                    📒 {card.binders.map((b) => `${b.name} (${b.qty})`).join(' · ')}
                  </div>
                ) : null}
                {card.decks.length > 0 ? (
                  <div className="mt-0.5 flex flex-wrap gap-x-2 text-sm" style={{ color: 'var(--text-dim)' }}>
                    🃏{' '}
                    {card.decks.map((d, i) => (
                      <Link key={d.id} href={`/collection/decks/${d.id}`} className="underline-offset-2 hover:underline">
                        {d.name} ({d.qty}){i < card.decks.length - 1 ? ',' : ''}
                      </Link>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="text-right">
                <div className="font-display text-lg" style={{ color: card.freeQty > 0 ? 'var(--cast)' : 'var(--text-faint)' }}>
                  {card.freeQty}/{card.ownedQty}
                </div>
                <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
                  free / owned
                </div>
              </div>
            </Panel>
          ))}
        </div>
      )}
    </Shell>
  )
}

function FilterChip({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-full px-3 py-1 text-xs capitalize"
      style={active ? { background: 'var(--frame-gold)', color: '#1c1407' } : { border: '1px solid rgba(201,154,58,0.3)', color: 'var(--text-dim)' }}
    >
      {children}
    </Link>
  )
}
