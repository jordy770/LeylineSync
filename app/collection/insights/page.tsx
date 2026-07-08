import Link from 'next/link'
import { redirect } from 'next/navigation'

import { CardName } from '@/components/collection/CardName'
import { Panel, Shell } from '@/components/collection/Shell'
import { getCollectionInsights } from '@/lib/collection/insights'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export default async function InsightsPage() {
  const supabase = await createClient()
  const { data: claims, error } = await supabase.auth.getClaims()
  if (error || !claims?.claims?.sub) redirect('/auth/login')

  const ins = await getCollectionInsights(supabase, claims.claims.sub as string)
  const empty = ins.perfectFits.length === 0 && ins.unusedStaples.length === 0

  return (
    <Shell
      title="Collection insights"
      lead="What your whole collection says — best fits per deck, and strong cards going to waste."
      active="insights"
    >
      {empty ? (
        <Panel className="p-6">
          <p className="font-rules text-sm" style={{ color: 'var(--text-dim)' }}>
            Import a collection and a deck or two — then this page shows the best binder card for each deck and your unused staples.
          </p>
        </Panel>
      ) : null}

      {ins.perfectFits.length > 0 ? (
        <section className="mb-10">
          <h2 className="mb-3 font-display text-xl" style={{ color: 'var(--text-bright)' }}>
            Perfect fits
          </h2>
          <p className="font-rules mb-3 text-sm" style={{ color: 'var(--text-dim)' }}>
            The single best free upgrade your binder offers each deck.
          </p>
          <div className="space-y-2">
            {ins.perfectFits.map((f) => (
              <Link key={`${f.deckId}-${f.oracleId}`} href={`/collection/decks/${f.deckId}`}>
                <Panel className="flex items-center justify-between gap-4 p-4 transition-transform hover:scale-[1.01]">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <CardName name={f.name} className="font-display text-base" style={{ color: 'var(--text-bright)' }} />
                      <span style={{ color: 'var(--frame-gold)' }}>→</span>
                      <span className="text-sm" style={{ color: 'var(--text)' }}>
                        {f.deckName}
                      </span>
                      <Tag>{f.tag.replace(/_/g, ' ')}</Tag>
                      {f.themeImpact === 'Keeps Theme' ? <Tag tone="var(--cast)">on-theme</Tag> : null}
                    </div>
                    {f.binderNames && f.binderNames.length > 0 ? (
                      <div className="mt-1 text-xs" style={{ color: 'var(--text-faint)' }}>
                        📒 in {f.binderNames.join(', ')}
                      </div>
                    ) : null}
                  </div>
                  <Confidence value={f.confidence} />
                </Panel>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {ins.unusedStaples.length > 0 ? (
        <section>
          <h2 className="mb-3 font-display text-xl" style={{ color: 'var(--text-bright)' }}>
            Unused staples
          </h2>
          <p className="font-rules mb-3 text-sm" style={{ color: 'var(--text-dim)' }}>
            Strong cards you own but haven&apos;t put in any deck.
          </p>
          <Panel className="divide-y p-0">
            {ins.unusedStaples.map((s) => (
              <div key={s.oracleId} className="flex items-center justify-between px-4 py-2.5" style={{ borderColor: 'rgba(201,154,58,0.12)' }}>
                <div className="flex items-center gap-2">
                  <CardName name={s.name} className="font-display text-sm" style={{ color: 'var(--text-bright)' }} />
                  <Tag>{s.tag.replace(/_/g, ' ')}</Tag>
                  {s.binderNames && s.binderNames.length > 0 ? (
                    <span className="text-xs" style={{ color: 'var(--text-faint)' }}>
                      📒 {s.binderNames.join(', ')}
                    </span>
                  ) : null}
                </div>
                <span className="text-xs" style={{ color: 'var(--text-faint)' }}>
                  {s.priceEur != null ? `€${s.priceEur.toFixed(2)}` : ''}
                </span>
              </div>
            ))}
          </Panel>
        </section>
      ) : null}
    </Shell>
  )
}

function Tag({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide"
      style={{ color: tone ?? 'var(--text-faint)', border: `1px solid ${tone ?? 'rgba(201,154,58,0.25)'}` }}
    >
      {children}
    </span>
  )
}

function Confidence({ value }: { value: number }) {
  const tone = value >= 70 ? 'var(--cast)' : value >= 45 ? 'var(--warn)' : 'var(--text-faint)'
  return (
    <div className="shrink-0 text-right">
      <div className="font-display text-lg" style={{ color: tone }}>
        {value}%
      </div>
      <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
        fit
      </div>
    </div>
  )
}
