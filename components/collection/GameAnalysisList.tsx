'use client'

import { useState } from 'react'

import { Panel } from './ui'

// Finished games with one-click AI post-mortems (premium). The analysis renders
// inline under the game it belongs to.

interface GameRow {
  id: string
  date: string
  won: boolean
  format: string
}
interface Analysis {
  summary: string
  keyMoments: string[]
  whatToImprove: string[]
  deckAdvice: string[]
}

export function GameAnalysisList({ games }: { games: GameRow[] }) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, Analysis>>({})
  const [errors, setErrors] = useState<Record<string, { message: string; code?: string }>>({})

  async function analyze(id: string) {
    setBusyId(id)
    setErrors((e) => ({ ...e, [id]: undefined as never }))
    try {
      const res = await fetch(`/api/games/${id}/analyze`, { method: 'POST' })
      const body = await res.json()
      if (!res.ok) setErrors((e) => ({ ...e, [id]: { message: body.error ?? 'Analysis failed.', code: body.code } }))
      else setResults((r) => ({ ...r, [id]: body }))
    } catch {
      setErrors((e) => ({ ...e, [id]: { message: 'Network error during analysis.' } }))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-3">
      {games.map((g) => {
        const analysis = results[g.id]
        const error = errors[g.id]
        return (
          <Panel key={g.id} className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="font-display text-sm" style={{ color: 'var(--text-bright)' }}>
                  {g.date.slice(0, 10)}
                </span>
                <span className="text-xs capitalize" style={{ color: 'var(--text-faint)' }}>
                  {g.format}
                </span>
                <span
                  className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide"
                  style={
                    g.won
                      ? { color: 'var(--cast)', border: '1px solid var(--cast)' }
                      : { color: 'var(--text-faint)', border: '1px solid rgba(201,154,58,0.25)' }
                  }
                >
                  {g.won ? '🏆 won' : 'lost'}
                </span>
              </div>
              {!analysis ? (
                <button
                  onClick={() => analyze(g.id)}
                  disabled={busyId !== null}
                  className="rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-40"
                  style={{ background: 'linear-gradient(150deg, var(--gold-bright), var(--frame-gold))', color: '#1c1407' }}
                >
                  {busyId === g.id ? 'Reviewing…' : '🎮 Analyse'}
                </button>
              ) : null}
            </div>

            {error ? (
              error.code === 'premium_required' ? (
                <p className="font-rules mt-3 text-sm" style={{ color: 'var(--text-dim)' }}>
                  <span style={{ color: 'var(--gold-bright)' }}>🎮 Post-game coaching is a premium feature</span> —
                  premium covers the AI costs.
                </p>
              ) : (
                <p className="mt-3 text-sm" style={{ color: error.code === 'quota_exceeded' ? 'var(--warn)' : 'var(--danger)' }}>
                  {error.message}
                </p>
              )
            ) : null}

            {analysis ? (
              <div className="bnd-ai mt-3 space-y-3 rounded-xl p-4">
                <p className="font-rules text-sm" style={{ color: 'var(--text)' }}>
                  {analysis.summary}
                </p>
                <AnalysisBlock title="Key moments" items={analysis.keyMoments} tone="var(--gold-bright)" />
                <AnalysisBlock title="What to improve" items={analysis.whatToImprove} tone="var(--warn)" />
                <AnalysisBlock title="Deck takeaways — paste one into the Doctor's goal field" items={analysis.deckAdvice} tone="var(--cast)" />
              </div>
            ) : null}
          </Panel>
        )
      })}
    </div>
  )
}

function AnalysisBlock({ title, items, tone }: { title: string; items: string[]; tone: string }) {
  if (items.length === 0) return null
  return (
    <div>
      <h4 className="text-xs uppercase tracking-wide" style={{ color: tone }}>
        {title}
      </h4>
      <ul className="font-rules mt-1 list-disc space-y-1 pl-5 text-sm" style={{ color: 'var(--text-dim)' }}>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  )
}
