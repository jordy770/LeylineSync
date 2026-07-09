import Link from 'next/link'
import { redirect } from 'next/navigation'

import { CardPocket } from '@/components/collection/CardPocket'
import { Panel, Shell, spineColor } from '@/components/collection/Shell'
import { getBinderContents, listBinders } from '@/lib/collection/binders'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

// /collection/binders                        → the shelf (spines, tap to open)
// /collection/binders?binder=X&sort=…&p=N    → binder X as 12-pocket pages

const SORTS = ['name', 'price', 'type'] as const
type BinderSort = (typeof SORTS)[number]
const PAGE_SIZE = 12
const SPINE_CYCLE = ['G', 'U', 'R', 'B', 'W']

function sortCards<T extends { name: string; priceEur: number | null; typeLine: string | null }>(cards: T[], sort: BinderSort): T[] {
  if (sort === 'price') return [...cards].sort((a, b) => (b.priceEur ?? 0) - (a.priceEur ?? 0) || a.name.localeCompare(b.name))
  if (sort === 'type') return [...cards].sort((a, b) => (a.typeLine ?? '').localeCompare(b.typeLine ?? '') || a.name.localeCompare(b.name))
  return cards // getBinderContents already returns name-sorted
}

function binderUrl(binder: string, sort: BinderSort, page: number): string {
  const params = new URLSearchParams({ binder })
  if (sort !== 'name') params.set('sort', sort)
  if (page > 1) params.set('p', String(page))
  return `/collection/binders?${params}`
}

export default async function BindersPage({
  searchParams,
}: {
  searchParams: Promise<{ binder?: string; sort?: string; p?: string }>
}) {
  const supabase = await createClient()
  const { data: claims, error } = await supabase.auth.getClaims()
  if (error || !claims?.claims?.sub) redirect('/auth/login')
  const userId = claims.claims.sub as string

  const { binder, sort: sortParam, p } = await searchParams
  const sort: BinderSort = SORTS.includes(sortParam as BinderSort) ? (sortParam as BinderSort) : 'name'

  if (binder) {
    const cards = sortCards(await getBinderContents(supabase, userId, binder), sort)
    const total = cards.reduce((n, c) => n + c.qty, 0)
    const value = cards.reduce((sum, c) => sum + (c.priceEur ?? 0) * c.qty, 0)
    const pages = Math.max(1, Math.ceil(cards.length / PAGE_SIZE))
    const page = Math.min(pages, Math.max(1, Number(p) || 1))
    const slice = cards.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

    return (
      <Shell
        title={`📒 ${binder}`}
        lead={`${total} cards · ${cards.length} unique · ≈€${value.toFixed(2)} · page ${page} of ${pages}`}
        active="binders"
        actions={
          <Link href="/collection/binders" className="rounded-lg px-4 py-2 text-sm" style={{ border: '1px solid rgba(201,154,58,0.4)', color: 'var(--text)' }}>
            ← All binders
          </Link>
        }
      >
        {cards.length === 0 ? (
          <Panel className="p-6">
            <p className="font-rules text-sm" style={{ color: 'var(--text-dim)' }}>
              This binder is empty (or doesn&apos;t exist anymore after a re-import).
            </p>
          </Panel>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs" style={{ color: 'var(--text-faint)' }}>
              <span>Sort by</span>
              {SORTS.map((s) => (
                <Link
                  key={s}
                  href={binderUrl(binder, s, 1)}
                  className="rounded-full px-2.5 py-0.5"
                  style={
                    sort === s
                      ? { background: 'var(--frame-gold)', color: '#1c1407' }
                      : { border: '1px solid rgba(201,154,58,0.3)', color: 'var(--text-dim)' }
                  }
                >
                  {s}
                </Link>
              ))}
            </div>
            <Panel className="p-4">
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
                {slice.map((c) => (
                  <Link
                    key={c.oracleId}
                    href={`/collection/search?q=${encodeURIComponent(c.name)}`}
                    title={`${c.name}${c.typeLine ? ` · ${c.typeLine}` : ''}`}
                    className="transition-transform hover:scale-[1.03]"
                  >
                    <CardPocket name={c.name} colors={c.colorIdentity} priceEur={c.priceEur} qty={c.qty} />
                  </Link>
                ))}
              </div>
              <div className="mt-5 flex items-center justify-center gap-3 text-sm">
                {page > 1 ? (
                  <Link href={binderUrl(binder, sort, page - 1)} className="rounded-lg px-4 py-2" style={{ border: '1px solid rgba(201,154,58,0.4)', color: 'var(--text)' }}>
                    ← previous page
                  </Link>
                ) : null}
                <span className="text-xs" style={{ color: 'var(--text-faint)' }}>
                  {page} / {pages}
                </span>
                {page < pages ? (
                  <Link href={binderUrl(binder, sort, page + 1)} className="rounded-lg px-4 py-2" style={{ border: '1px solid rgba(201,154,58,0.4)', color: 'var(--text)' }}>
                    next page →
                  </Link>
                ) : null}
              </div>
            </Panel>
          </>
        )}
      </Shell>
    )
  }

  const binders = await listBinders(supabase, userId)
  const maxCards = Math.max(1, ...binders.map((b) => b.totalCards))

  return (
    <Shell title="Binders" lead="Your physical binders, as they sit on the shelf — tap a spine to open it." active="binders">
      {binders.length === 0 ? (
        <Panel className="p-6">
          <p className="font-rules text-sm" style={{ color: 'var(--text-dim)' }}>
            No binders yet — import your ManaBox collection first.
          </p>
          <Link href="/collection/import" className="mt-3 inline-block rounded-lg px-4 py-2 text-sm font-medium" style={{ border: '1px solid rgba(201,154,58,0.4)', color: 'var(--text)' }}>
            Import collection
          </Link>
        </Panel>
      ) : (
        <div className="mt-2">
          <div className="flex flex-wrap items-end gap-3 px-2">
            {binders.map((b, i) => {
              const height = 120 + Math.round((b.totalCards / maxCards) * 70)
              return (
                <Link key={b.name} href={binderUrl(b.name, 'name', 1)} className="transition-transform hover:-translate-y-1">
                  <span className="bnd-spine" style={{ height, borderTopColor: spineColor([SPINE_CYCLE[i % SPINE_CYCLE.length]]) }}>
                    <i>{b.name}</i>
                    <em>{b.totalCards}</em>
                  </span>
                </Link>
              )
            })}
          </div>
          <div className="bnd-shelfboard" />
          <p className="font-rules mt-4 text-xs" style={{ color: 'var(--text-faint)' }}>
            Spine height follows the card count. {binders.length} binders · {binders.reduce((n, b) => n + b.totalCards, 0)} cards sleeved.
          </p>
        </div>
      )}
    </Shell>
  )
}
