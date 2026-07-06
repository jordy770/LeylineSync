'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

// One-click conflict resolution: release the card from one of the claiming
// decks. The server removes the co_deck_cards row and re-scores that deck.
export function ConflictResolve({ oracleId, decks }: { oracleId: string; decks: { id: string; name: string }[] }) {
  const router = useRouter()
  const [busyDeck, setBusyDeck] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function release(deckId: string) {
    setBusyDeck(deckId)
    setError(null)
    try {
      const res = await fetch('/api/collection/resolve-conflict', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ oracleId, deckId }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'Could not release the card.')
        return
      }
      router.refresh()
    } catch {
      setError('Network error.')
    } finally {
      setBusyDeck(null)
    }
  }

  return (
    <div className="mt-2 flex w-full flex-wrap items-center gap-2">
      <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
        release from
      </span>
      {decks.map((d) => (
        <button
          key={d.id}
          onClick={() => release(d.id)}
          disabled={busyDeck !== null}
          className="rounded-full px-3 py-1 text-xs disabled:opacity-40"
          style={{ border: '1px solid rgba(217,165,59,0.5)', color: 'var(--warn)' }}
        >
          {busyDeck === d.id ? '…' : d.name}
        </button>
      ))}
      {error ? (
        <span className="text-xs" style={{ color: 'var(--danger)' }}>
          {error}
        </span>
      ) : null}
    </div>
  )
}
