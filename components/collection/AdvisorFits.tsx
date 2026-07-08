'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'

import { CardName } from './CardName'
import { Panel } from './ui'

// Perfect fits with a one-click Apply — adds the binder card to its deck right
// from the Advisor (the deck page's scanner suggests what to cut). Ghost
// button: the contested cards' "Keep in" stays this screen's primary action.
// Same 10s-undo convention as everywhere else.

export interface FitView {
  oracleId: string
  name: string
  deckId: string
  deckName: string
  tag: string
  confidence: number
  onTheme: boolean
  binderNames: string[]
}

export function AdvisorFits({ fits }: { fits: FitView[] }) {
  const router = useRouter()
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [undo, setUndo] = useState<{ label: string; run: () => Promise<void> } | null>(null)
  const undoTimer = useRef<number | null>(null)

  const offerUndo = useCallback((label: string, run: () => Promise<void>) => {
    if (undoTimer.current != null) window.clearTimeout(undoTimer.current)
    setUndo({ label, run })
    undoTimer.current = window.setTimeout(() => setUndo(null), 10_000)
  }, [])

  useEffect(() => {
    return () => {
      if (undoTimer.current != null) window.clearTimeout(undoTimer.current)
    }
  }, [])

  async function apply(f: FitView) {
    setBusyKey(f.deckId)
    setError(null)
    try {
      const res = await fetch(`/api/decks/${f.deckId}/swaps`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inOracleId: f.oracleId }),
      })
      const body = await res.json()
      if (!res.ok) setError(body.error ?? 'Could not add the card.')
      else {
        offerUndo(`${f.name} added to ${f.deckName}`, async () => {
          const undoRes = await fetch(`/api/decks/${f.deckId}/swaps`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ outOracleId: f.oracleId }),
          })
          if (!undoRes.ok) throw new Error((await undoRes.json().catch(() => ({}))).error ?? 'Undo failed.')
        })
        router.refresh()
      }
    } catch {
      setError('Network error while adding.')
    } finally {
      setBusyKey(null)
    }
  }

  async function runUndo() {
    if (!undo) return
    const entry = undo
    setUndo(null)
    setBusyKey('undo')
    setError(null)
    try {
      await entry.run()
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Undo failed.')
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <div className="space-y-2">
      {error ? (
        <p className="text-sm" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      ) : null}
      {fits.map((f) => (
        <Panel key={`${f.deckId}-${f.oracleId}`} className="flex items-center justify-between gap-4 p-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <CardName name={f.name} className="font-display text-base" style={{ color: 'var(--text-bright)' }} />
              <span style={{ color: 'var(--frame-gold)' }}>→</span>
              <Link href={`/collection/decks/${f.deckId}`} className="text-sm underline-offset-2 hover:underline" style={{ color: 'var(--text)' }}>
                {f.deckName}
              </Link>
              <Tag>{f.tag.replace(/_/g, ' ')}</Tag>
              {f.onTheme ? <Tag tone="var(--cast)">on-theme</Tag> : null}
            </div>
            {f.binderNames.length > 0 ? (
              <div className="mt-1 text-xs" style={{ color: 'var(--text-faint)' }}>
                📒 in {f.binderNames.join(', ')}
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <div className="text-right">
              <div className="font-display text-lg" style={{ color: f.confidence >= 70 ? 'var(--cast)' : f.confidence >= 45 ? 'var(--warn)' : 'var(--text-faint)' }}>
                {f.confidence}%
              </div>
              <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
                fit
              </div>
            </div>
            <button
              onClick={() => apply(f)}
              disabled={busyKey !== null}
              className="rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-40"
              style={{ border: '1px solid rgba(201,154,58,0.45)', color: 'var(--gold-bright)' }}
            >
              {busyKey === f.deckId ? '…' : 'Add to deck'}
            </button>
          </div>
        </Panel>
      ))}

      {undo ? (
        <div
          className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-4 rounded-xl px-4 py-2.5 shadow-2xl"
          style={{ background: 'var(--ink-2)', border: '1px solid rgba(201,154,58,0.4)' }}
        >
          <span className="text-sm" style={{ color: 'var(--text)' }}>
            {undo.label}
          </span>
          <button
            onClick={runUndo}
            disabled={busyKey !== null}
            className="rounded-lg px-3 py-1 text-sm font-medium disabled:opacity-40"
            style={{ color: 'var(--gold-bright)', border: '1px solid rgba(201,154,58,0.45)' }}
          >
            {busyKey === 'undo' ? '…' : 'Undo'}
          </button>
        </div>
      ) : null}
    </div>
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
