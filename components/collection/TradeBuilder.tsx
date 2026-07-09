'use client'

import { useState } from 'react'

import { CardName } from './CardName'
import { Panel } from './ui'

// ✨ Trade package builder (premium): "I want X" → a fair offer assembled from
// your own free binder cards, totals recomputed server-side from real prices.

interface TradeCard {
  name: string
  priceEur: number
}
interface TradeResult {
  rationale: string
  cards: TradeCard[]
  totalEur: number
  alternates: TradeCard[]
}

export function TradeBuilder() {
  const [want, setWant] = useState('')
  const [target, setTarget] = useState('')
  const [result, setResult] = useState<TradeResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; code?: string } | null>(null)

  async function run() {
    if (!want.trim()) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/trade', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ want: want.trim(), targetValueEur: target === '' ? null : Number(target) }),
      })
      const body = await res.json()
      if (!res.ok) setError({ message: body.error ?? 'The trade builder could not run.', code: body.code })
      else setResult(body)
    } catch {
      setError({ message: 'Network error building the trade.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <Panel className="space-y-3 p-4">
        <p className="font-rules text-sm" style={{ color: 'var(--text-dim)' }}>
          Trading for something? Say what you want — the builder assembles a fair package from your spare binder cards
          at market prices, with swap-in alternates.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={want}
            onChange={(e) => setWant(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void run()}
            maxLength={200}
            placeholder="e.g. “Dockside Extortionist” or “his Rhystic Study, mint”"
            className="font-rules min-w-64 flex-1 rounded-lg bg-transparent px-3 py-2 text-sm"
            style={{ border: '1px solid rgba(201,154,58,0.3)', color: 'var(--text)' }}
          />
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value.replace(/[^0-9.]/g, ''))}
            placeholder="target €"
            className="font-rules w-24 rounded-lg bg-transparent px-3 py-2 text-sm"
            style={{ border: '1px solid rgba(201,154,58,0.3)', color: 'var(--text)' }}
            aria-label="Target value in euros (optional)"
          />
          <button
            onClick={run}
            disabled={busy || !want.trim()}
            className="rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-40"
            style={{ background: 'linear-gradient(150deg, var(--gold-bright), var(--frame-gold))', color: '#1c1407' }}
          >
            {busy ? 'Building…' : 'Build package'}
          </button>
        </div>
      </Panel>

      {error ? (
        <Panel className="p-5">
          {error.code === 'premium_required' ? (
            <p className="font-rules text-sm" style={{ color: 'var(--text-dim)' }}>
              <span style={{ color: 'var(--gold-bright)' }}>✨ The trade builder is a premium feature</span> — premium
              covers the AI costs.
            </p>
          ) : (
            <p className="text-sm" style={{ color: error.code === 'quota_exceeded' ? 'var(--warn)' : 'var(--danger)' }}>
              {error.message}
            </p>
          )}
        </Panel>
      ) : null}

      {result ? (
        <Panel className="p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h4 className="font-display text-sm" style={{ color: 'var(--gold-bright)' }}>
              The offer
            </h4>
            <span className="font-display text-lg" style={{ color: 'var(--text-bright)' }}>
              ≈€{result.totalEur.toFixed(2)}
            </span>
          </div>
          <ul className="font-rules mt-2 space-y-1 text-sm" style={{ color: 'var(--text)' }}>
            {result.cards.map((c) => (
              <li key={c.name} className="flex items-baseline justify-between gap-2">
                <CardName name={c.name} className="font-display" style={{ color: 'var(--text-bright)' }} />
                <span className="text-xs" style={{ color: 'var(--text-faint)' }}>
                  €{c.priceEur.toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
          <p className="font-rules mt-3 text-sm" style={{ color: 'var(--text-dim)' }}>
            {result.rationale}
          </p>
          {result.alternates.length > 0 ? (
            <p className="font-rules mt-2 text-xs" style={{ color: 'var(--text-faint)' }}>
              Swap-ins at similar value:{' '}
              {result.alternates.map((a, i) => (
                <span key={a.name}>
                  <CardName name={a.name} /> (€{a.priceEur.toFixed(2)}){i < result.alternates.length - 1 ? ', ' : ''}
                </span>
              ))}
            </p>
          ) : null}
        </Panel>
      ) : null}
    </div>
  )
}
