'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

import { CardName } from './CardName'
import { ColorPips, Panel } from './ui'

// Instant collection search — results update as you type (debounced), no page
// reloads. The URL stays in sync via router.replace so a search remains
// shareable/bookmarkable, and the server-rendered first paint (initialResults)
// is reused so deep links don't flash a loading state.

interface LocatedCard {
  oracleId: string
  name: string
  ownedQty: number
  freeQty: number
  binders: { name: string; qty: number }[]
  decks: { id: string; name: string; qty: number }[]
  colorIdentity: string[]
  typeLine: string | null
}

const COLORS = ['W', 'U', 'B', 'R', 'G'] as const
const TYPES = ['creature', 'instant', 'sorcery', 'artifact', 'enchantment', 'land'] as const
const DEBOUNCE_MS = 250

export function SearchLive({
  initialQ,
  initialFree,
  initialColor,
  initialType,
  initialResults,
}: {
  initialQ: string
  initialFree: boolean
  initialColor: string | null
  initialType: string | null
  initialResults: LocatedCard[]
}) {
  const router = useRouter()
  const [q, setQ] = useState(initialQ)
  const [freeOnly, setFreeOnly] = useState(initialFree)
  const [color, setColor] = useState<string | null>(initialColor)
  const [type, setType] = useState<string | null>(initialType)
  const [results, setResults] = useState<LocatedCard[]>(initialResults)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Skip the fetch for the state the server already rendered.
  const lastKey = useRef(searchKey(initialQ, initialFree, initialColor, initialType))

  useEffect(() => {
    const key = searchKey(q, freeOnly, color, type)
    if (key === lastKey.current) return

    const params = new URLSearchParams()
    if (q.trim()) params.set('q', q.trim())
    if (freeOnly) params.set('free', '1')
    if (color) params.set('color', color)
    if (type) params.set('type', type)

    if (q.trim().length < 2) {
      lastKey.current = key
      setResults([])
      setBusy(false)
      router.replace(`/collection/search${params.size ? `?${params}` : ''}`, { scroll: false })
      return
    }

    setBusy(true)
    setError(null)
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/collection/search?${params}`)
        const body = await res.json()
        if (!res.ok) {
          setError(body.error ?? 'Search failed.')
          return
        }
        lastKey.current = key
        setResults(body.results ?? [])
        router.replace(`/collection/search?${params}`, { scroll: false })
      } catch {
        setError('Network error while searching.')
      } finally {
        setBusy(false)
      }
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [q, freeOnly, color, type, router])

  return (
    <div>
      <div className="mb-4 flex max-w-md items-center gap-2">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Card name…"
          autoFocus
          className="w-full rounded-lg px-3 py-2 text-sm outline-none"
          style={{ border: '1px solid rgba(201,154,58,0.3)', background: 'var(--ink-2)', color: 'var(--text)' }}
        />
        {busy ? (
          <span className="animate-pulse text-xs" style={{ color: 'var(--text-faint)' }}>
            …
          </span>
        ) : null}
      </div>

      {q.trim() ? (
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <FilterChip active={freeOnly} onClick={() => setFreeOnly(!freeOnly)}>
            Free copies only
          </FilterChip>
          {COLORS.map((c) => (
            <FilterChip key={c} active={color === c} onClick={() => setColor(color === c ? null : c)}>
              {c}
            </FilterChip>
          ))}
          {TYPES.map((t) => (
            <FilterChip key={t} active={type === t} onClick={() => setType(type === t ? null : t)}>
              {t}
            </FilterChip>
          ))}
        </div>
      ) : null}

      {error ? (
        <Panel className="p-6">
          <p className="font-rules text-sm" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        </Panel>
      ) : q.trim().length < 2 ? (
        <Panel className="p-6">
          <p className="font-rules text-sm" style={{ color: 'var(--text-dim)' }}>
            Type a card name (two letters is enough) to see where your copies live.
          </p>
        </Panel>
      ) : results.length === 0 && !busy ? (
        <Panel className="p-6">
          <p className="font-rules text-sm" style={{ color: 'var(--text-dim)' }}>
            Nothing in your collection matches “{q.trim()}”{freeOnly || color || type ? ' with these filters' : ''}.
          </p>
        </Panel>
      ) : (
        <div className="space-y-2">
          {results.map((card) => (
            <Panel key={card.oracleId} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <CardName name={card.name} className="font-display text-base" style={{ color: 'var(--text-bright)' }} />
                  <ColorPips colors={card.colorIdentity} />
                  {card.typeLine ? (
                    <span className="text-xs" style={{ color: 'var(--text-faint)' }}>
                      {card.typeLine}
                    </span>
                  ) : null}
                </div>
                {card.binders.length > 0 ? (
                  <div className="mt-1 text-sm" style={{ color: 'var(--text-dim)' }}>
                    📒 {card.binders.map((b) => `${b.name} (${b.qty})`).join(' · ')}
                  </div>
                ) : null}
                {card.decks.length > 0 ? (
                  <div className="mt-0.5 flex flex-wrap gap-x-2 text-sm" style={{ color: 'var(--text-dim)' }}>
                    🃏{' '}
                    {card.decks.map((d, i) => (
                      <Link key={d.id} href={`/collection/decks/${d.id}`} className="underline-offset-2 hover:underline">
                        {d.name} ({d.qty}){i < card.decks.length - 1 ? ',' : ''}
                      </Link>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="text-right">
                <div className="font-display text-lg" style={{ color: card.freeQty > 0 ? 'var(--cast)' : 'var(--text-faint)' }}>
                  {card.freeQty}/{card.ownedQty}
                </div>
                <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
                  free / owned
                </div>
              </div>
            </Panel>
          ))}
        </div>
      )}
    </div>
  )
}

function searchKey(q: string, free: boolean, color: string | null, type: string | null): string {
  return JSON.stringify([q.trim(), free, color, type])
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="rounded-full px-3 py-1 text-xs capitalize"
      style={active ? { background: 'var(--frame-gold)', color: '#1c1407' } : { border: '1px solid rgba(201,154,58,0.3)', color: 'var(--text-dim)' }}
    >
      {children}
    </button>
  )
}
