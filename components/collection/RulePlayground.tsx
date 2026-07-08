'use client'

import { useEffect, useState } from 'react'

// Panel comes from the client-safe ui module — importing it via Shell would
// drag SiteNav→AuthButton→the server-only Supabase client into the client graph.
import { Panel } from './ui'

interface ClassifyResponse {
  card: { name: string; typeLine: string | null; oracleText: string | null; cmc: number | null }
  profile: {
    roles: { role: string; weight: number }[]
    tags: string[]
    hits: { ruleId: string; description: string; evidence?: string }[]
    legacyTags: { tag: string; weight: number }[]
  }
  synergies: { commander: string; score: number; contributions: { key: string; weight: number }[] }[]
  ruleCount: number
  suggestions: string[]
}

export function RulePlayground() {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<ClassifyResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Debounced live classification while typing.
  useEffect(() => {
    const q = query.trim()
    if (q.length < 3) return
    const t = setTimeout(() => {
      setBusy(true)
      setError(null)
      fetch(`/api/intelligence/classify?name=${encodeURIComponent(q)}`)
        .then((r) => r.json().then((b) => ({ ok: r.ok, b })))
        .then(({ ok, b }) => {
          if (!ok) setError(b.error ?? 'Classification failed.')
          else setResult(b)
        })
        .catch(() => setError('Network error.'))
        .finally(() => setBusy(false))
    }, 300)
    return () => clearTimeout(t)
  }, [query])

  return (
    <div className="space-y-4">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Card name… (e.g. Rhystic Study)"
        autoFocus
        className="w-full max-w-md rounded-lg px-3 py-2 text-sm outline-none"
        style={{ border: '1px solid rgba(201,154,58,0.3)', background: 'var(--ink-2)', color: 'var(--text)' }}
      />

      {error ? (
        <Panel className="p-4">
          <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>
        </Panel>
      ) : null}

      {result ? (
        <div className="grid gap-4 lg:grid-cols-2" style={{ opacity: busy ? 0.6 : 1 }}>
          {/* Card + profile */}
          <Panel className="p-5">
            <h3 className="font-display text-lg" style={{ color: 'var(--text-bright)' }}>
              {result.card.name}
            </h3>
            <p className="text-xs" style={{ color: 'var(--text-faint)' }}>
              {result.card.typeLine} · MV {result.card.cmc ?? '—'}
            </p>
            {result.card.oracleText ? (
              <p className="font-rules mt-2 whitespace-pre-wrap text-sm" style={{ color: 'var(--text-dim)' }}>
                {result.card.oracleText}
              </p>
            ) : null}

            <h4 className="mt-4 text-xs uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
              Roles
            </h4>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {result.profile.roles.length === 0 ? (
                <span className="text-sm" style={{ color: 'var(--text-faint)' }}>—</span>
              ) : (
                result.profile.roles.map((r) => (
                  <span key={r.role} className="rounded px-2 py-0.5 text-xs" style={{ color: 'var(--gold-bright)', border: '1px solid rgba(201,154,58,0.4)' }}>
                    {r.role.replace(/_/g, ' ')} <span style={{ color: 'var(--text-faint)' }}>×{r.weight}</span>
                  </span>
                ))
              )}
            </div>

            <h4 className="mt-3 text-xs uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
              Tags
            </h4>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {result.profile.tags.map((t) => (
                <span key={t} className="rounded px-1.5 py-0.5 text-[10px]" style={{ color: 'var(--text-dim)', border: '1px solid rgba(201,154,58,0.2)' }}>
                  {t}
                </span>
              ))}
            </div>

            <h4 className="mt-3 text-xs uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
              Legacy tags (score contract)
            </h4>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {result.profile.legacyTags.map((t) => (
                <span key={t.tag} className="rounded px-1.5 py-0.5 text-[10px]" style={{ color: 'var(--cast)', border: '1px solid var(--cast)' }}>
                  {t.tag} ×{t.weight}
                </span>
              ))}
            </div>
          </Panel>

          {/* Why: rule hits + commander synergies */}
          <div className="space-y-4">
            <Panel className="p-5">
              <h4 className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
                Why — {result.profile.hits.length} of {result.ruleCount} rules fired
              </h4>
              <ul className="mt-2 space-y-1.5">
                {result.profile.hits.map((h) => (
                  <li key={h.ruleId} className="text-sm">
                    <code className="rounded px-1 py-0.5 text-[11px]" style={{ background: 'var(--ink-2)', color: 'var(--gold-bright)' }}>
                      {h.ruleId}
                    </code>{' '}
                    <span style={{ color: 'var(--text)' }}>{h.description}</span>
                    {h.evidence ? (
                      <div className="font-rules text-xs italic" style={{ color: 'var(--text-faint)' }}>
                        “…{h.evidence}…”
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel className="p-5">
              <h4 className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
                Commander synergy
              </h4>
              {result.synergies.length === 0 ? (
                <p className="mt-2 text-sm" style={{ color: 'var(--text-faint)' }}>
                  No profiled commander wants this card in particular.
                </p>
              ) : (
                <ul className="mt-2 space-y-1">
                  {result.synergies.map((s) => (
                    <li key={s.commander} className="flex items-baseline justify-between gap-3 text-sm">
                      <span style={{ color: 'var(--text)' }}>{s.commander}</span>
                      <span
                        className="font-display"
                        style={{ color: s.score > 0 ? 'var(--cast)' : 'var(--danger)' }}
                        title={s.contributions.map((c) => `${c.key} ${c.weight > 0 ? '+' : ''}${c.weight}`).join(', ')}
                      >
                        {s.score > 0 ? '+' : ''}{s.score}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </div>
      ) : (
        <Panel className="p-6">
          <p className="font-rules text-sm" style={{ color: 'var(--text-dim)' }}>
            Type a card name to classify it. You&apos;ll see every rule that fired (with the oracle-text
            evidence), the resulting roles and tags, the legacy score tags, and which commanders want it.
          </p>
        </Panel>
      )}
    </div>
  )
}
