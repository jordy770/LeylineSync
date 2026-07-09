'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'

import { CardName } from './CardName'
import { CardPocket } from './CardPocket'
import { ShopLinksInline } from './ShopLinks'
import { Panel } from './ui'

// Contested cards WITH the arbiter's one-click resolution. "Keep in <winner>"
// releases the card from every losing deck in one go; individual release chips
// stay for overriding the advice. Every action offers a 10s undo (the released
// deck rows are re-added via the swaps endpoint), so following advice is never
// a commitment — same pattern as DeckDetail.

export interface ContestedView {
  oracleId: string
  cardName: string
  ownedQty: number
  committedQty: number
  ranking: { deckId: string; deckName: string; value: number; reasons: string[] }[]
  alternatives: string[]
}

export function AdvisorContested({ contested }: { contested: ContestedView[] }) {
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

  async function releaseFrom(oracleId: string, deckIds: string[]): Promise<string[]> {
    // Returns the deck ids actually released; throws on the first failure.
    const released: string[] = []
    for (const deckId of deckIds) {
      const res = await fetch('/api/collection/resolve-conflict', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ oracleId, deckId }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Could not release the card.')
      }
      released.push(deckId)
    }
    return released
  }

  function addBackUndo(oracleId: string, deckIds: string[]) {
    return async () => {
      for (const deckId of deckIds) {
        const res = await fetch(`/api/decks/${deckId}/swaps`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ inOracleId: oracleId }),
        })
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Undo failed partway.')
      }
    }
  }

  async function run(key: string, label: string, oracleId: string, deckIds: string[]) {
    setBusyKey(key)
    setError(null)
    try {
      const released = await releaseFrom(oracleId, deckIds)
      offerUndo(label, addBackUndo(oracleId, released))
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error.')
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
      {contested.map((c) => {
        // Follow-advice keeps the card in the top-ranked deck(s) — as many as
        // you own copies of (at least one) — and releases the rest.
        const keepCount = Math.max(1, c.ownedQty)
        const losers = c.ranking.slice(keepCount)
        const winner = c.ranking[0]
        return (
          <Panel key={c.oracleId} className="flex gap-4 p-5">
            <CardPocket name={c.cardName} className="hidden w-20 shrink-0 self-start sm:block" />
            <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-display text-base" style={{ color: 'var(--text-bright)' }}>
                <CardName name={c.cardName} />
              </span>
              <span className="text-xs" style={{ color: 'var(--text-faint)' }}>
                {c.ownedQty} owned / {c.committedQty} wanted
              </span>
            </div>

            <ol className="mt-2 space-y-1.5">
              {c.ranking.map((v, i) => (
                <li key={v.deckId} className="text-sm">
                  <span className="font-display" style={{ color: i === 0 ? 'var(--cast)' : 'var(--text-dim)' }}>
                    {i === 0 ? '★ ' : `${i + 1}. `}
                    <Link href={`/collection/decks/${v.deckId}`} className="underline-offset-2 hover:underline">
                      {v.deckName}
                    </Link>{' '}
                    ({v.value > 0 ? '+' : ''}
                    {v.value})
                  </span>
                  <span className="font-rules text-xs" style={{ color: 'var(--text-faint)' }}>
                    {' '}
                    — {v.reasons.join('; ')}
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

            <div className="mt-3 flex flex-wrap items-center gap-2">
              {losers.length > 0 && winner ? (
                <button
                  onClick={() =>
                    run(
                      `advice-${c.oracleId}`,
                      `${c.cardName} released from ${losers.map((l) => l.deckName).join(', ')}`,
                      c.oracleId,
                      losers.map((l) => l.deckId),
                    )
                  }
                  disabled={busyKey !== null}
                  className="rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-40"
                  style={{ background: 'linear-gradient(150deg, var(--gold-bright), var(--frame-gold))', color: '#1c1407' }}
                >
                  {busyKey === `advice-${c.oracleId}` ? '…' : `★ Keep in ${winner.deckName}`}
                </button>
              ) : null}
              <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
                or release from
              </span>
              {c.ranking.map((d) => (
                <button
                  key={d.deckId}
                  onClick={() => run(`rel-${c.oracleId}-${d.deckId}`, `${c.cardName} released from ${d.deckName}`, c.oracleId, [d.deckId])}
                  disabled={busyKey !== null}
                  className="rounded-full px-3 py-1 text-xs disabled:opacity-40"
                  style={{ border: '1px solid rgba(217,165,59,0.5)', color: 'var(--warn)' }}
                >
                  {busyKey === `rel-${c.oracleId}-${d.deckId}` ? '…' : d.deckName}
                </button>
              ))}
              <span className="ml-auto">
                <ShopLinksInline name={c.cardName} />
              </span>
            </div>
            </div>
          </Panel>
        )
      })}

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
