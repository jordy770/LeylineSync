'use client'

import { useCallback, useEffect, useState } from 'react'

import { ColorPips, Panel } from './Shell'

type ThemeImpact = 'Keeps Theme' | 'Neutral' | 'Weakens Theme'
interface PowerScore {
  power: number
  buckets: Record<string, number>
  avgMv: number
  landCount: number
  needs: { tag: string; have: number; target: number; gap: number }[]
  health: { axis: string; score: number; explanation: string }[]
  explanation: string
}
interface FreeUpgrade {
  in: { oracleId: string; name: string; priceEur: number | null }
  out: { oracleId: string; name: string } | null
  tag: string
  delta: number
  confidence: number
  themeImpact: ThemeImpact
  binderNames?: string[]
  reason: string
}
interface OccupiedUpgrade {
  in: { oracleId: string; name: string }
  tag: string
  confidence: number
  themeImpact: ThemeImpact
  usedBy: { id: string; name: string }[]
  action: string
  reason: string
}
interface ScanResult {
  power: PowerScore
  free: FreeUpgrade[]
  occupied: OccupiedUpgrade[]
}
interface AiPick {
  name: string
  tag: string
  source: string
  priceEur: number | null
  confidence: number
  themeImpact: ThemeImpact
  verdict: 'include' | 'consider' | 'skip'
  reason: string
}
interface BuySuggestion {
  oracleId: string
  name: string
  tag: string
  priceEur: number | null
  confidence: number
  themeImpact: ThemeImpact
  scryfallUrl: string
  reason: string
}

const BUCKET_ORDER = ['ramp', 'card_draw', 'removal', 'board_wipe', 'counterspell', 'tutor'] as const

export function DeckDetail({ deckId, colorIdentity }: { deckId: string; colorIdentity: string[] }) {
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'free' | 'occupied' | 'buy'>('free')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [buyBudget, setBuyBudget] = useState<string>('5')
  const [buys, setBuys] = useState<BuySuggestion[] | null>(null)
  const [buyBusy, setBuyBusy] = useState(false)
  const [buyError, setBuyError] = useState<string | null>(null)
  const [budget, setBudget] = useState<string>('') // '', '2', '5', '10'
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [ai, setAi] = useState<{ summary: string; picks: AiPick[] } | null>(null)

  // The upgrades endpoint also returns the power score, so one call covers both.
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/decks/${deckId}/upgrades`)
      const body = await res.json()
      if (!res.ok) {
        setError(body.error ?? 'Could not analyse this deck.')
        return
      }
      setScan(body)
    } catch {
      setError('Network error.')
    }
  }, [deckId])

  useEffect(() => {
    void load()
  }, [load])

  // Buy suggestions are fetched lazily — only when the Buy tab is open, and re-fetched
  // when the budget changes.
  useEffect(() => {
    if (tab !== 'buy') return
    let live = true
    setBuyBusy(true)
    setBuyError(null)
    fetch(`/api/decks/${deckId}/buy?budget=${buyBudget}`)
      .then((r) => r.json().then((b) => ({ ok: r.ok, b })))
      .then(({ ok, b }) => {
        if (!live) return
        if (!ok) setBuyError(b.error ?? 'Could not load buy suggestions.')
        else setBuys(b.buys ?? [])
      })
      .catch(() => live && setBuyError('Network error loading buy suggestions.'))
      .finally(() => live && setBuyBusy(false))
    return () => {
      live = false
    }
  }, [tab, buyBudget, deckId])

  // Apply a free upgrade (cut OUT, add IN), then re-scan so the score + lists update.
  async function applyFree(u: FreeUpgrade, key: string) {
    setBusyKey(key)
    setActionError(null)
    try {
      const res = await fetch(`/api/decks/${deckId}/swaps`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inOracleId: u.in.oracleId, outOracleId: u.out?.oracleId ?? null }),
      })
      const body = await res.json()
      if (!res.ok) setActionError(body.error ?? 'Could not apply the swap.')
      else await load()
    } catch {
      setActionError('Network error applying the swap.')
    } finally {
      setBusyKey(null)
    }
  }

  async function moveHere(u: OccupiedUpgrade, key: string) {
    setBusyKey(key)
    setActionError(null)
    try {
      const res = await fetch('/api/collection/move-card', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ oracleId: u.in.oracleId, fromDeckId: u.usedBy[0]?.id, toDeckId: deckId }),
      })
      const body = await res.json()
      if (!res.ok) setActionError(body.error ?? 'Could not move the card.')
      else await load()
    } catch {
      setActionError('Network error moving the card.')
    } finally {
      setBusyKey(null)
    }
  }

  async function askDoctor() {
    setAiBusy(true)
    setAiError(null)
    setAi(null)
    try {
      const res = await fetch(`/api/decks/${deckId}/recommend`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ budget: budget === '' ? null : Number(budget) }),
      })
      const body = await res.json()
      if (!res.ok) setAiError(body.error ?? 'The deck doctor is unavailable.')
      else setAi(body)
    } catch {
      setAiError('Network error reaching the deck doctor.')
    } finally {
      setAiBusy(false)
    }
  }

  if (error) {
    return (
      <Panel className="p-6">
        <p style={{ color: 'var(--danger)' }}>{error}</p>
      </Panel>
    )
  }
  if (!scan) {
    return (
      <Panel className="p-6">
        <p className="font-rules" style={{ color: 'var(--text-dim)' }}>
          Analysing deck…
        </p>
      </Panel>
    )
  }

  const { power, free, occupied } = scan

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-[auto_1fr]">
        <Panel className="flex items-center gap-5 p-6">
          <Gauge score={power.power} />
          <div>
            <div className="flex items-center gap-2">
              <ColorPips colors={colorIdentity} />
              <span className="text-xs" style={{ color: 'var(--text-faint)' }}>
                {power.landCount} lands · avg MV {power.avgMv}
              </span>
            </div>
            <p className="font-rules mt-2 max-w-md text-sm" style={{ color: 'var(--text-dim)' }}>
              {power.explanation}
            </p>
          </div>
        </Panel>

        <Panel className="p-6">
          <h3 className="mb-3 text-xs uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
            Composition
          </h3>
          <div className="grid grid-cols-3 gap-3">
            {BUCKET_ORDER.map((tag) => {
              const need = power.needs.find((n) => n.tag === tag)
              return (
                <div key={tag}>
                  <div className="font-display text-xl" style={{ color: need ? 'var(--warn)' : 'var(--gold-bright)' }}>
                    {power.buckets[tag] ?? 0}
                    {need ? <span className="text-xs" style={{ color: 'var(--text-faint)' }}> /{need.target}</span> : null}
                  </div>
                  <div className="text-[11px] capitalize" style={{ color: 'var(--text-faint)' }}>
                    {tag.replace(/_/g, ' ')}
                  </div>
                </div>
              )
            })}
          </div>
        </Panel>
      </div>

      <HealthPanel health={power.health} />

      <Panel className="p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-lg" style={{ color: 'var(--text-bright)' }}>
              Deck doctor
            </h3>
            <p className="font-rules text-sm" style={{ color: 'var(--text-dim)' }}>
              AI ranks &amp; explains upgrades from your collection — keeping the deck on-theme.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              className="rounded-lg px-3 py-2 text-sm"
              style={{ border: '1px solid rgba(201,154,58,0.3)', background: 'var(--ink-2)', color: 'var(--text)' }}
            >
              <option value="">No budget</option>
              <option value="2">Under €2</option>
              <option value="5">Under €5</option>
              <option value="10">Under €10</option>
            </select>
            <button
              onClick={askDoctor}
              disabled={aiBusy}
              className="rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-40"
              style={{ background: 'linear-gradient(150deg, var(--gold-bright), var(--frame-gold))', color: '#1c1407' }}
            >
              {aiBusy ? 'Consulting…' : 'Ask the deck doctor'}
            </button>
          </div>
        </div>

        {aiError ? (
          <p className="mt-3 text-sm" style={{ color: 'var(--danger)' }}>
            {aiError}
          </p>
        ) : null}

        {ai ? (
          <div className="mt-4 space-y-3">
            <p className="font-rules text-sm" style={{ color: 'var(--text)' }}>
              {ai.summary}
            </p>
            <ul className="space-y-2">
              {ai.picks.map((p, i) => (
                <li key={i} className="rounded-lg p-3" style={{ border: '1px solid rgba(201,154,58,0.18)' }}>
                  <div className="flex items-center gap-2">
                    <VerdictBadge verdict={p.verdict} />
                    <span className="font-display text-sm" style={{ color: 'var(--text-bright)' }}>
                      {p.name}
                    </span>
                    <Chip>{p.tag.replace(/_/g, ' ')}</Chip>
                    {p.source === 'buy' ? (
                      <span className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide" style={{ color: 'var(--warn)', border: '1px solid var(--warn)' }}>
                        buy
                      </span>
                    ) : p.source === 'occupied' ? (
                      <Chip>in a deck</Chip>
                    ) : null}
                    <ConfidenceBadge value={p.confidence} />
                    <ThemeBadge impact={p.themeImpact} />
                    {p.priceEur != null ? (
                      <span className="text-xs" style={{ color: 'var(--text-faint)' }}>
                        €{p.priceEur.toFixed(2)}
                      </span>
                    ) : null}
                  </div>
                  <p className="font-rules mt-1 text-sm" style={{ color: 'var(--text-dim)' }}>
                    {p.reason}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Panel>

      <div>
        <div className="mb-3 flex gap-2">
          <Tab active={tab === 'free'} onClick={() => setTab('free')}>
            Free upgrades ({free.length})
          </Tab>
          <Tab active={tab === 'occupied'} onClick={() => setTab('occupied')}>
            Occupied ({occupied.length})
          </Tab>
          <Tab active={tab === 'buy'} onClick={() => setTab('buy')}>
            Buy
          </Tab>
        </div>
        {actionError ? (
          <p className="mb-3 text-sm" style={{ color: 'var(--danger)' }}>
            {actionError}
          </p>
        ) : null}

        {tab === 'free' ? (
          free.length === 0 ? (
            <Empty>No free upgrades found in your binder for this deck&apos;s needs.</Empty>
          ) : (
            <div className="space-y-2">
              {free.map((u, i) => (
                <Panel key={i} className="flex items-center justify-between gap-4 p-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      {u.out ? (
                        <>
                          <span className="text-sm line-through" style={{ color: 'var(--text-faint)' }}>
                            {u.out.name}
                          </span>
                          <span style={{ color: 'var(--frame-gold)' }}>→</span>
                        </>
                      ) : (
                        <span className="text-xs uppercase tracking-wide" style={{ color: 'var(--cast)' }}>
                          add
                        </span>
                      )}
                      <span className="font-display text-base" style={{ color: 'var(--text-bright)' }}>
                        {u.in.name}
                      </span>
                      <Chip>{u.tag.replace(/_/g, ' ')}</Chip>
                      <ConfidenceBadge value={u.confidence} />
                      <ThemeBadge impact={u.themeImpact} />
                    </div>
                    <p className="font-rules mt-1 text-sm" style={{ color: 'var(--text-dim)' }}>
                      {u.reason}
                    </p>
                    <BinderTag names={u.binderNames} />
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <div className="text-right">
                      <div className="font-display text-lg" style={{ color: 'var(--cast)' }}>
                        +{u.delta}
                      </div>
                      {u.in.priceEur != null ? (
                        <div className="text-xs" style={{ color: 'var(--text-faint)' }}>
                          €{u.in.priceEur.toFixed(2)}
                        </div>
                      ) : null}
                    </div>
                    <button
                      onClick={() => applyFree(u, `free-${i}`)}
                      disabled={busyKey !== null}
                      className="rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-40"
                      style={{ background: 'linear-gradient(150deg, var(--gold-bright), var(--frame-gold))', color: '#1c1407' }}
                    >
                      {busyKey === `free-${i}` ? '…' : u.out ? 'Apply' : 'Add'}
                    </button>
                  </div>
                </Panel>
              ))}
            </div>
          )
        ) : tab === 'occupied' ? (
          occupied.length === 0 ? (
            <Empty>Nothing that fits is locked in another deck.</Empty>
          ) : (
          <div className="space-y-2">
            {occupied.map((u, i) => (
              <Panel key={i} className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-display text-base" style={{ color: 'var(--text-bright)' }}>
                      {u.in.name}
                    </span>
                    <Chip>{u.tag.replace(/_/g, ' ')}</Chip>
                    <ConfidenceBadge value={u.confidence} />
                    <ThemeBadge impact={u.themeImpact} />
                  </div>
                  <p className="font-rules mt-1 text-sm" style={{ color: 'var(--text-dim)' }}>
                    {u.reason}
                  </p>
                </div>
                {u.action === 'move' ? (
                  <button
                    onClick={() => moveHere(u, `occ-${i}`)}
                    disabled={busyKey !== null}
                    className="shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-40"
                    style={{ border: '1px solid rgba(217,165,59,0.5)', color: 'var(--warn)' }}
                  >
                    {busyKey === `occ-${i}` ? '…' : 'Move here'}
                  </button>
                ) : (
                  <span className="shrink-0 rounded px-2 py-1 text-xs uppercase tracking-wide" style={{ color: 'var(--text-faint)', border: '1px solid rgba(201,154,58,0.3)' }} title="Owned by several decks — buy a copy or proxy">
                    buy
                  </span>
                )}
              </Panel>
            ))}
          </div>
          )
        ) : (
          <BuyTab buys={buys} busy={buyBusy} error={buyError} budget={buyBudget} setBudget={setBuyBudget} />
        )}
      </div>
    </div>
  )
}

function BuyTab({
  buys,
  busy,
  error,
  budget,
  setBudget,
}: {
  buys: BuySuggestion[] | null
  busy: boolean
  error: string | null
  budget: string
  setBudget: (b: string) => void
}) {
  const chips: { label: string; value: string }[] = [
    { label: 'Under €2', value: '2' },
    { label: 'Under €5', value: '5' },
    { label: 'Under €10', value: '10' },
    { label: 'No budget', value: '' },
  ]
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {chips.map((c) => (
          <button
            key={c.value}
            onClick={() => setBudget(c.value)}
            className="rounded-full px-3 py-1 text-xs"
            style={
              budget === c.value
                ? { background: 'var(--frame-gold)', color: '#1c1407' }
                : { border: '1px solid rgba(201,154,58,0.3)', color: 'var(--text-dim)' }
            }
          >
            {c.label}
          </button>
        ))}
      </div>

      {busy ? (
        <Empty>Searching the card pool…</Empty>
      ) : error ? (
        <Empty>{error}</Empty>
      ) : !buys || buys.length === 0 ? (
        <Empty>No purchase suggestions for this deck&apos;s needs within the budget.</Empty>
      ) : (
        <div className="space-y-2">
          {buys.map((b) => (
            <Panel key={b.oracleId} className="flex items-center justify-between gap-4 p-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-display text-base" style={{ color: 'var(--text-bright)' }}>
                    {b.name}
                  </span>
                  <Chip>{b.tag.replace(/_/g, ' ')}</Chip>
                  <ConfidenceBadge value={b.confidence} />
                  <ThemeBadge impact={b.themeImpact} />
                </div>
                <p className="font-rules mt-1 text-sm" style={{ color: 'var(--text-dim)' }}>
                  {b.reason}
                </p>
              </div>
              <a
                href={b.scryfallUrl}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 rounded-lg px-3 py-1.5 text-sm"
                style={{ border: '1px solid rgba(201,154,58,0.4)', color: 'var(--text)' }}
              >
                {b.priceEur != null ? `€${b.priceEur.toFixed(2)} ↗` : 'View ↗'}
              </a>
            </Panel>
          ))}
        </div>
      )}
    </div>
  )
}

function Gauge({ score }: { score: number }) {
  const angle = Math.max(0, Math.min(1, score / 10)) * 360
  return (
    <div
      className="grid h-24 w-24 shrink-0 place-items-center rounded-full"
      style={{ background: `conic-gradient(var(--gold-bright) ${angle}deg, rgba(201,154,58,0.15) ${angle}deg)` }}
    >
      <div className="grid h-[78px] w-[78px] place-items-center rounded-full" style={{ background: 'var(--ink-2)' }}>
        <div className="font-display text-2xl" style={{ color: 'var(--text-bright)' }}>
          {score.toFixed(1)}
        </div>
        <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
          /10
        </div>
      </div>
    </div>
  )
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="rounded-lg px-4 py-2 text-sm font-medium"
      style={
        active
          ? { background: 'linear-gradient(150deg, var(--gold-bright), var(--frame-gold))', color: '#1c1407' }
          : { border: '1px solid rgba(201,154,58,0.3)', color: 'var(--text-dim)' }
      }
    >
      {children}
    </button>
  )
}

function VerdictBadge({ verdict }: { verdict: 'include' | 'consider' | 'skip' }) {
  const tone = verdict === 'include' ? 'var(--cast)' : verdict === 'consider' ? 'var(--warn)' : 'var(--text-faint)'
  return (
    <span className="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide" style={{ color: tone, border: `1px solid ${tone}` }}>
      {verdict}
    </span>
  )
}

function ConfidenceBadge({ value }: { value: number }) {
  const tone = value >= 70 ? 'var(--cast)' : value >= 45 ? 'var(--warn)' : 'var(--text-faint)'
  return (
    <span className="rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ color: tone, border: `1px solid ${tone}` }} title="Engine confidence — fit for this deck">
      {value}%
    </span>
  )
}

function ThemeBadge({ impact }: { impact: ThemeImpact }) {
  if (impact === 'Neutral') return null
  const keeps = impact === 'Keeps Theme'
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide"
      style={{ color: keeps ? 'var(--cast)' : 'var(--danger)', border: `1px solid ${keeps ? 'var(--cast)' : 'var(--danger)'}` }}
      title={keeps ? 'Reinforces your deck theme' : 'Pulls away from your deck theme'}
    >
      {keeps ? 'on-theme' : 'off-theme'}
    </span>
  )
}

function HealthPanel({ health }: { health: { axis: string; score: number; explanation: string }[] }) {
  if (!health || health.length === 0) return null
  return (
    <Panel className="p-6">
      <h3 className="mb-3 text-xs uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
        Deck health
      </h3>
      <div className="space-y-2.5">
        {health.map((h) => {
          const tone = h.score >= 75 ? 'var(--cast)' : h.score >= 50 ? 'var(--warn)' : 'var(--danger)'
          return (
            <div key={h.axis} title={h.explanation}>
              <div className="flex items-baseline justify-between text-sm">
                <span style={{ color: 'var(--text)' }}>{h.axis}</span>
                <span className="font-display" style={{ color: tone }}>
                  {h.score}%
                </span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'rgba(201,154,58,0.12)' }}>
                <div className="h-full rounded-full" style={{ width: `${h.score}%`, background: tone }} />
              </div>
              <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-faint)' }}>
                {h.explanation}
              </div>
            </div>
          )
        })}
      </div>
    </Panel>
  )
}

function BinderTag({ names }: { names?: string[] }) {
  if (!names || names.length === 0) return null
  return (
    <div className="mt-1 text-xs" style={{ color: 'var(--text-faint)' }}>
      📒 in {names.join(', ')}
    </div>
  )
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-faint)', border: '1px solid rgba(201,154,58,0.25)' }}>
      {children}
    </span>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <Panel className="p-6">
      <p className="font-rules text-sm" style={{ color: 'var(--text-dim)' }}>
        {children}
      </p>
    </Panel>
  )
}
