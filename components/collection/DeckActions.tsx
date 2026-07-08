'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

// Deck header actions: inline rename and a two-step delete (first click arms
// it, second confirms — no modal). Delete redirects to the collection
// overview; the deck's cards are freed for other decks by the DB cascade.

export function DeckActions({ deckId, name }: { deckId: string; name: string }) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState<'rename' | 'delete' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function rename() {
    const next = draft.trim()
    if (!next || next === name) {
      setEditing(false)
      setDraft(name)
      return
    }
    setBusy('rename')
    setError(null)
    try {
      const res = await fetch(`/api/decks/${deckId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: next }),
      })
      const body = await res.json()
      if (!res.ok) setError(body.error ?? 'Rename failed.')
      else {
        setEditing(false)
        router.refresh()
      }
    } catch {
      setError('Network error while renaming.')
    } finally {
      setBusy(null)
    }
  }

  async function remove() {
    if (!armed) {
      setArmed(true)
      window.setTimeout(() => setArmed(false), 4000)
      return
    }
    setBusy('delete')
    setError(null)
    try {
      const res = await fetch(`/api/decks/${deckId}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'Delete failed.')
        return
      }
      router.push('/collection')
      router.refresh()
    } catch {
      setError('Network error while deleting.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {editing ? (
        <>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void rename()
              if (e.key === 'Escape') {
                setEditing(false)
                setDraft(name)
              }
            }}
            autoFocus
            maxLength={120}
            className="rounded-lg bg-transparent px-3 py-2 text-sm"
            style={{ border: '1px solid rgba(201,154,58,0.4)', color: 'var(--text)' }}
            aria-label="Deck name"
          />
          <button
            onClick={rename}
            disabled={busy !== null}
            className="rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-40"
            style={{ background: 'linear-gradient(150deg, var(--gold-bright), var(--frame-gold))', color: '#1c1407' }}
          >
            {busy === 'rename' ? '…' : 'Save'}
          </button>
        </>
      ) : (
        <button
          onClick={() => setEditing(true)}
          className="rounded-lg px-4 py-2 text-sm"
          style={{ border: '1px solid rgba(201,154,58,0.4)', color: 'var(--text)' }}
        >
          Rename
        </button>
      )}
      <button
        onClick={remove}
        disabled={busy !== null}
        className="rounded-lg px-4 py-2 text-sm disabled:opacity-40"
        style={
          armed
            ? { background: 'var(--danger)', color: '#fff' }
            : { border: '1px solid rgba(220,80,80,0.5)', color: 'var(--danger)' }
        }
      >
        {busy === 'delete' ? '…' : armed ? 'Really delete?' : 'Delete'}
      </button>
      {error ? (
        <span className="text-xs" style={{ color: 'var(--danger)' }}>
          {error}
        </span>
      ) : null}
    </div>
  )
}
