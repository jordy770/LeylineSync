import Link from 'next/link'
import { redirect } from 'next/navigation'

import { CardName } from '@/components/collection/CardName'
import { Shell } from '@/components/collection/Shell'
import { Panel } from '@/components/collection/ui'
import { loadCollectionIntelligence } from '@/lib/intelligence/loaders'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

// Collection Intelligence — the engine's collection-wide verdicts: per-deck
// diagnosed issues (with confidence) and contested cards with an explained
// "where does this card belong" arbitration. All local rules, no AI.

export default async function IntelligencePage() {
  const supabase = await createClient()
  const { data: claims, error } = await supabase.auth.getClaims()
  if (error || !claims?.claims?.sub) redirect('/auth/login')
  const userId = claims.claims.sub as string

  const { decks, contested } = await loadCollectionIntelligence(supabase, userId)
  const totalIssues = decks.reduce((n, d) => n + d.intel.issues.length, 0)

  return (
    <Shell
      title="Collection Intelligence"
      lead="What the rule engine concludes about your decks — every verdict traceable, no AI involved."
      active="intelligence"
    >
      {decks.length === 0 ? (
        <Panel className="p-6">
          <p className="font-rules text-sm" style={{ color: 'var(--text-dim)' }}>
            Import a deck first — then the engine can diagnose it.
          </p>
        </Panel>
      ) : (
        <div className="space-y-8">
          {/* Contested cards — the arbiter's calls */}
          <section>
            <h2 className="mb-3 text-xs uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
              Contested cards ({contested.length})
            </h2>
            {contested.length === 0 ? (
              <Panel className="p-5">
                <p className="font-rules text-sm" style={{ color: 'var(--text-dim)' }}>
                  No card is wanted by more decks than you own copies of.
                </p>
              </Panel>
            ) : (
              <div className="space-y-2">
                {contested.map((c) => (
                  <Panel key={c.arbitration.cardName} className="p-5">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-display text-base" style={{ color: 'var(--text-bright)' }}>
                        <CardName name={c.arbitration.cardName} />
                      </span>
                      <span className="text-xs" style={{ color: 'var(--text-faint)' }}>
                        {c.ownedQty} owned / {c.committedQty} wanted
                      </span>
                    </div>
                    <ol className="mt-2 space-y-1.5">
                      {c.arbitration.ranking.map((v, i) => (
                        <li key={v.deckId} className="text-sm">
                          <span className="font-display" style={{ color: i === 0 ? 'var(--cast)' : 'var(--text-dim)' }}>
                            {i === 0 ? '★ ' : `${i + 1}. `}
                            <Link href={`/collection/decks/${v.deckId}`} className="underline-offset-2 hover:underline">
                              {v.deckName}
                            </Link>{' '}
                            ({v.value > 0 ? '+' : ''}{v.value})
                          </span>
                          <span className="font-rules text-xs" style={{ color: 'var(--text-faint)' }}>
                            {' '}— {v.reasons.join('; ')}
                          </span>
                        </li>
                      ))}
                    </ol>
                    {c.alternatives.length > 0 ? (
                      <p className="font-rules mt-2 text-xs" style={{ color: 'var(--text-dim)' }}>
                        Free look-alikes in your binder:{' '}
                        {c.alternatives.map((a, i) => (
                          <span key={a}>
                            <CardName name={a} />
                            {i < c.alternatives.length - 1 ? ', ' : ''}
                          </span>
                        ))}
                      </p>
                    ) : null}
                  </Panel>
                ))}
              </div>
            )}
          </section>

          {/* Per-deck diagnosis */}
          <section>
            <h2 className="mb-3 text-xs uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
              Deck diagnosis ({totalIssues} findings across {decks.length} decks)
            </h2>
            <div className="grid gap-3 md:grid-cols-2">
              {decks.map((d) => (
                <Panel key={d.deckId} className="p-5">
                  <div className="flex items-baseline justify-between gap-2">
                    <Link href={`/collection/decks/${d.deckId}`} className="font-display text-base underline-offset-2 hover:underline" style={{ color: 'var(--text-bright)' }}>
                      {d.deckName}
                    </Link>
                    <span className="text-xs" style={{ color: 'var(--text-faint)' }}>
                      {d.intel.cardCount} cards · {d.intel.landCount} lands · {d.intel.manaSources} mana sources · MV {d.intel.avgManaValue}
                    </span>
                  </div>

                  {d.intel.issues.length === 0 ? (
                    <p className="font-rules mt-2 text-sm" style={{ color: 'var(--cast)' }}>
                      No structural issues found.
                    </p>
                  ) : (
                    <ul className="mt-2 space-y-1.5">
                      {d.intel.issues.map((issue) => (
                        <li key={issue.id} className="text-sm">
                          <span style={{ color: issue.confidence >= 0.8 ? 'var(--danger)' : 'var(--warn)' }}>
                            {issue.issue}
                          </span>{' '}
                          <span className="text-xs" style={{ color: 'var(--text-faint)' }}>
                            {Math.round(issue.confidence * 100)}%
                          </span>
                          <div className="font-rules text-xs" style={{ color: 'var(--text-dim)' }}>
                            {issue.detail}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="mt-3 flex flex-wrap gap-1">
                    {d.intel.roleCounts.slice(0, 8).map((r) => (
                      <span key={r.role} className="rounded px-1.5 py-0.5 text-[10px]" style={{ color: 'var(--text-dim)', border: '1px solid rgba(201,154,58,0.2)' }}>
                        {r.role.replace(/_/g, ' ')} {r.count}
                      </span>
                    ))}
                  </div>
                </Panel>
              ))}
            </div>
          </section>
        </div>
      )}
    </Shell>
  )
}
