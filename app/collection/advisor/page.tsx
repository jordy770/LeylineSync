import Link from 'next/link'
import { redirect } from 'next/navigation'

import { AdvisorContested } from '@/components/collection/AdvisorContested'
import { AdvisorFits } from '@/components/collection/AdvisorFits'
import { CardName } from '@/components/collection/CardName'
import { TradeBuilder } from '@/components/collection/TradeBuilder'
import { Panel, Shell } from '@/components/collection/Shell'
import { getCollectionInsights } from '@/lib/collection/insights'
import { loadCollectionIntelligence } from '@/lib/intelligence/loaders'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

// The Advisor — ONE page for everything the engine concludes about your
// collection, with the actions next to the verdicts. Merges the former
// Insights, Intelligence and Conflicts pages (their URLs redirect here):
// contested cards (arbiter ranking + one-click resolution), the best fit per
// deck, per-deck diagnosis, and strong cards going to waste.

export default async function AdvisorPage() {
  const supabase = await createClient()
  const { data: claims, error } = await supabase.auth.getClaims()
  if (error || !claims?.claims?.sub) redirect('/auth/login')
  const userId = claims.claims.sub as string

  const [{ decks, contested }, ins] = await Promise.all([
    loadCollectionIntelligence(supabase, userId),
    getCollectionInsights(supabase, userId),
  ])
  const totalIssues = decks.reduce((n, d) => n + d.intel.issues.length, 0)
  const empty = decks.length === 0 && ins.perfectFits.length === 0 && ins.unusedStaples.length === 0

  return (
    <Shell
      title="Advisor"
      lead="Everything the rule engine concludes about your collection — every verdict traceable, no AI involved."
      active="advisor"
    >
      {empty ? (
        <Panel className="p-6">
          <p className="font-rules text-sm" style={{ color: 'var(--text-dim)' }}>
            Import a collection and a deck or two — then the Advisor shows contested cards, the best binder card for
            each deck, and strong cards going to waste.
          </p>
        </Panel>
      ) : (
        <div className="space-y-10">
          {/* Contested cards — the arbiter's calls, with one-click resolution */}
          <section>
            <h2 className="mb-3 text-xs uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
              Contested cards ({contested.length})
            </h2>
            {contested.length === 0 ? (
              <Panel className="p-5">
                <p className="font-rules text-sm" style={{ color: 'var(--text-dim)' }}>
                  No card is wanted by more decks than you own copies of. Nicely sorted.
                </p>
              </Panel>
            ) : (
              <AdvisorContested
                contested={contested.map((c) => ({
                  oracleId: c.oracleId,
                  cardName: c.arbitration.cardName,
                  ownedQty: c.ownedQty,
                  committedQty: c.committedQty,
                  ranking: c.arbitration.ranking,
                  alternatives: c.alternatives,
                }))}
              />
            )}
          </section>

          {/* Perfect fits — the single best free upgrade per deck */}
          {ins.perfectFits.length > 0 ? (
            <section>
              <h2 className="mb-1 text-xs uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
                Perfect fits
              </h2>
              <p className="font-rules mb-3 text-sm" style={{ color: 'var(--text-dim)' }}>
                The single best free upgrade your binder offers each deck — add it right here, or open the deck to see
                what to cut.
              </p>
              <AdvisorFits
                fits={ins.perfectFits.map((f) => ({
                  oracleId: f.oracleId,
                  name: f.name,
                  deckId: f.deckId,
                  deckName: f.deckName,
                  tag: f.tag,
                  confidence: f.confidence,
                  onTheme: f.themeImpact === 'Keeps Theme',
                  binderNames: f.binderNames ?? [],
                }))}
              />
            </section>
          ) : null}

          {/* Per-deck diagnosis */}
          {decks.length > 0 ? (
            <section>
              <h2 className="mb-3 text-xs uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
                Deck diagnosis ({totalIssues} findings across {decks.length} decks)
              </h2>
              <div className="grid gap-3 md:grid-cols-2">
                {decks.map((d) => (
                  <Panel key={d.deckId} className="p-5">
                    <div className="flex items-baseline justify-between gap-2">
                      <Link
                        href={`/collection/decks/${d.deckId}`}
                        className="font-display text-base underline-offset-2 hover:underline"
                        style={{ color: 'var(--text-bright)' }}
                      >
                        {d.deckName}
                      </Link>
                      <span className="text-xs" style={{ color: 'var(--text-faint)' }}>
                        {d.intel.cardCount} cards · {d.intel.landCount} lands · {d.intel.manaSources} mana sources · MV{' '}
                        {d.intel.avgManaValue}
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
                        <span
                          key={r.role}
                          className="rounded px-1.5 py-0.5 text-[10px]"
                          style={{ color: 'var(--text-dim)', border: '1px solid rgba(201,154,58,0.2)' }}
                        >
                          {r.role.replace(/_/g, ' ')} {r.count}
                        </span>
                      ))}
                    </div>
                  </Panel>
                ))}
              </div>
            </section>
          ) : null}

          {/* Unused staples — each row links to "where does it live?" */}
          {ins.unusedStaples.length > 0 ? (
            <section>
              <h2 className="mb-1 text-xs uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
                Unused staples
              </h2>
              <p className="font-rules mb-3 text-sm" style={{ color: 'var(--text-dim)' }}>
                Strong cards you own but haven&apos;t put in any deck — click one to see where it lives.
              </p>
              <Panel className="divide-y p-0">
                {ins.unusedStaples.map((s) => (
                  <Link
                    key={s.oracleId}
                    href={`/collection/search?q=${encodeURIComponent(s.name)}`}
                    className="flex items-center justify-between px-4 py-2.5 hover:bg-[rgba(201,154,58,0.06)]"
                    style={{ borderColor: 'rgba(201,154,58,0.12)' }}
                  >
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
                  </Link>
                ))}
              </Panel>
            </section>
          ) : null}

          {/* Premium AI corners: trade packages + post-game coaching */}
          <section>
            <h2 className="mb-3 text-xs uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
              ✨ Trade builder
            </h2>
            <TradeBuilder />
          </section>

          <section>
            <Link href="/collection/games">
              <Panel className="flex items-center justify-between gap-4 p-4 transition-transform hover:scale-[1.005]">
                <div>
                  <div className="font-display text-sm" style={{ color: 'var(--text-bright)' }}>
                    🎮 Post-game coaching
                  </div>
                  <div className="font-rules text-xs" style={{ color: 'var(--text-dim)' }}>
                    AI analysis of your finished games, straight from the engine&apos;s own action log.
                  </div>
                </div>
                <span className="shrink-0 text-sm" style={{ color: 'var(--gold-bright)' }}>
                  →
                </span>
              </Panel>
            </Link>
          </section>
        </div>
      )}
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
