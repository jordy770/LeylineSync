import Link from 'next/link'
import { redirect } from 'next/navigation'

import { CardName } from '@/components/collection/CardName'
import { ColorPips, Panel, Shell } from '@/components/collection/Shell'
import { getBinderContents, listBinders } from '@/lib/collection/binders'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

// /collection/binders           → all binders with counts
// /collection/binders?binder=X  → what's in binder X

export default async function BindersPage({ searchParams }: { searchParams: Promise<{ binder?: string }> }) {
  const supabase = await createClient()
  const { data: claims, error } = await supabase.auth.getClaims()
  if (error || !claims?.claims?.sub) redirect('/auth/login')
  const userId = claims.claims.sub as string

  const { binder } = await searchParams

  if (binder) {
    const cards = await getBinderContents(supabase, userId, binder)
    const total = cards.reduce((n, c) => n + c.qty, 0)
    const value = cards.reduce((sum, c) => sum + (c.priceEur ?? 0) * c.qty, 0)
    return (
      <Shell
        title={`📒 ${binder}`}
        lead={`${total} cards · ${cards.length} unique · ≈€${value.toFixed(2)}`}
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
          <Panel className="divide-y p-0">
            {cards.map((c) => (
              <div key={c.oracleId} className="flex items-center justify-between gap-3 px-4 py-2.5" style={{ borderColor: 'rgba(201,154,58,0.12)' }}>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="w-8 shrink-0 text-right text-sm" style={{ color: 'var(--text-faint)' }}>
                    {c.qty}×
                  </span>
                  <CardName name={c.name} className="font-display text-sm" style={{ color: 'var(--text-bright)' }} />
                  <ColorPips colors={c.colorIdentity} />
                  {c.typeLine ? (
                    <span className="hidden text-xs sm:inline" style={{ color: 'var(--text-faint)' }}>
                      {c.typeLine}
                    </span>
                  ) : null}
                </div>
                <span className="shrink-0 text-xs" style={{ color: 'var(--text-faint)' }}>
                  {c.priceEur != null ? `€${c.priceEur.toFixed(2)}` : ''}
                </span>
              </div>
            ))}
          </Panel>
        )}
      </Shell>
    )
  }

  const binders = await listBinders(supabase, userId)
  return (
    <Shell title="Binders" lead="Your physical binders, as imported from ManaBox — open one to browse it." active="binders">
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
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {binders.map((b) => (
            <Link key={b.name} href={`/collection/binders?binder=${encodeURIComponent(b.name)}`}>
              <Panel className="p-4 transition-transform hover:scale-[1.01]">
                <div className="truncate font-display text-base" style={{ color: 'var(--text-bright)' }}>
                  📒 {b.name}
                </div>
                <div className="mt-1 text-xs" style={{ color: 'var(--text-faint)' }}>
                  {b.totalCards} cards · {b.uniqueCards} unique
                </div>
              </Panel>
            </Link>
          ))}
        </div>
      )}
    </Shell>
  )
}
