'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

import type { ContainerImportResult, DeckContainer } from '@/lib/collection/deck-containers'

import { Panel } from './ui'

// The decks hiding in a ManaBox collection export: every row tagged
// binder_type='deck' belongs to one of the user's ManaBox decks. This panel
// lists those containers and turns the selected ones into real LeylineSync
// decks — no decklist pasting. ManaBox doesn't mark the commander, so each
// deck gets a candidate picker (its legendary creatures); a lone candidate is
// preselected.

interface Props {
  /** Bump to refetch — the wizard raises this after a fresh collection import. */
  refreshKey: number
}

export function DeckContainersPanel({ refreshKey }: Props) {
  const [containers, setContainers] = useState<DeckContainer[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [commanderPick, setCommanderPick] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<ContainerImportResult[] | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/collection/deck-containers')
      .then((res) => res.json())
      .then((body) => {
        if (cancelled || !Array.isArray(body.containers)) return
        const found = body.containers as DeckContainer[]
        setContainers(found)
        setSelected(new Set(found.filter((c) => !c.alreadyImported).map((c) => c.name)))
        const picks: Record<string, string> = {}
        for (const c of found) {
          if (c.candidates.length === 1) picks[c.name] = c.candidates[0].oracleId
        }
        setCommanderPick(picks)
        setResults(null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  function toggle(name: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  async function importSelected() {
    if (selected.size === 0) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/collection/deck-containers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decks: [...selected].map((name) => ({ name, commanderOracleId: commanderPick[name] || null })),
        }),
      })
      const body = await res.json()
      if (!res.ok) {
        setError(body.error ?? 'Deck import failed.')
        return
      }
      setResults(body.results as ContainerImportResult[])
      // Freshly created decks now exist under their container name.
      setContainers((prev) => (prev ? prev.map((c) => (selected.has(c.name) ? { ...c, alreadyImported: true } : c)) : prev))
      setSelected(new Set())
    } catch {
      setError('Network error during the deck import.')
    } finally {
      setBusy(false)
    }
  }

  if (!containers || containers.length === 0) return null

  return (
    <Panel className="p-6">
      <h2 className="font-display text-lg" style={{ color: 'var(--text-bright)' }}>
        Decks in your ManaBox export
      </h2>
      <p className="font-rules mt-1 text-sm" style={{ color: 'var(--text-dim)' }}>
        These cards are tagged with a ManaBox deck. Import them as LeylineSync decks — pick the commander where
        ManaBox left it ambiguous.
      </p>

      <ul className="mt-4 space-y-2">
        {containers.map((c) => {
          const result = results?.find((r) => r.name === c.name)
          return (
            <li
              key={c.name}
              className="flex flex-wrap items-center gap-3 rounded-lg px-3 py-2"
              style={{ border: '1px solid rgba(201,154,58,0.18)' }}
            >
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  checked={selected.has(c.name)}
                  onChange={() => toggle(c.name)}
                  disabled={busy}
                  className="accent-[var(--frame-gold)]"
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium" style={{ color: 'var(--text-bright)' }}>
                    {c.name}
                  </span>
                  <span className="text-xs" style={{ color: 'var(--text-faint)' }}>
                    {c.totalCards} cards ({c.uniqueCards} unique)
                    {c.alreadyImported ? ' · already imported' : ''}
                  </span>
                </span>
              </label>

              {c.candidates.length > 1 ? (
                <select
                  value={commanderPick[c.name] ?? ''}
                  onChange={(e) => setCommanderPick((prev) => ({ ...prev, [c.name]: e.target.value }))}
                  disabled={busy}
                  className="rounded-md px-2 py-1 text-xs"
                  style={{ background: 'transparent', border: '1px solid rgba(201,154,58,0.3)', color: 'var(--text)' }}
                >
                  <option value="">Commander — pick one (optional)</option>
                  {c.candidates.map((cand) => (
                    <option key={cand.oracleId} value={cand.oracleId}>
                      {cand.name}
                    </option>
                  ))}
                </select>
              ) : c.candidates.length === 1 ? (
                <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
                  ⚔ {c.candidates[0].name}
                </span>
              ) : null}

              {result ? (
                result.deckId ? (
                  <Link
                    href={`/collection/decks/${result.deckId}`}
                    className="text-xs underline underline-offset-2"
                    style={{ color: 'var(--cast)' }}
                  >
                    imported ✓ — open
                  </Link>
                ) : (
                  <span className="text-xs" style={{ color: 'var(--danger)' }}>
                    {result.error}
                  </span>
                )
              ) : null}
            </li>
          )
        })}
      </ul>

      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={importSelected}
          disabled={busy || selected.size === 0}
          className="rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-40"
          style={{ background: 'linear-gradient(150deg, var(--gold-bright), var(--frame-gold))', color: '#1c1407' }}
        >
          {busy ? 'Importing…' : `Import ${selected.size} ${selected.size === 1 ? 'deck' : 'decks'}`}
        </button>
        {error ? (
          <span className="text-sm" style={{ color: 'var(--danger)' }}>
            {error}
          </span>
        ) : null}
      </div>
    </Panel>
  )
}
