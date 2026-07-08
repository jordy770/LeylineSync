'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { CardName } from './CardName'
import { ColorPips, Panel } from './ui'

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
interface PullList {
  groups: { binder: string; cards: { name: string; need: number }[] }[]
  missing: { name: string; need: number; inDecks: string[] }[]
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

export function DeckDetail({
  deckId,
  colorIdentity,
  source,
  sourceUrl,
}: {
  deckId: string
  colorIdentity: string[]
  source?: string | null
  sourceUrl?: string | null
}) {
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'free' | 'occupied' | 'buy' | 'pull'>('free')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [buyBudget, setBuyBudget] = useState<string>('5')
  const [buys, setBuys] = useState<BuySuggestion[] | null>(null)
  const [buyBusy, setBuyBusy] = useState(false)
  const [buyError, setBuyError] = useState<string | null>(null)
  const [pull, setPull] = useState<PullList | null>(null)
  const [pullBusy, setPullBusy] = useState(false)
  const [pullError, setPullError] = useState<string | null>(null)
  const [playBusy, setPlayBusy] = useState(false)
  const [playResult, setPlayResult] = useState<{ deckName: string; missing: { name: string }[] } | null>(null)
  const [playError, setPlayError] = useState<string | null>(null)
  const [syncBusy, setSyncBusy] = useState(false)
  const [syncResult, setSyncResult] = useState<{ added: { name: string; qty: number }[]; removed: { name: string; qty: number }[] } | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  // Undo toast: every apply/move offers a 10s window to reverse it, so trying
  // a recommendation is never a commitment.
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

  async function runUndo() {
    if (!undo) return
    const entry = undo
    setUndo(null)
    setBusyKey('undo')
    setActionError(null)
    try {
      await entry.run()
      await load()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Undo failed.')
    } finally {
      setBusyKey(null)
    }
  }

  // Bulk selection on the free-upgrades list, by index into the current scan;
  // any re-scan invalidates the indexes, so load() clears it.
  const [selected, setSelected] = useState<Set<number>>(new Set())

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
      setSelected(new Set())
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
      else {
        offerUndo(u.out ? `${u.in.name} in, ${u.out.name} out` : `${u.in.name} added`, async () => {
          const undoRes = await fetch(`/api/decks/${deckId}/swaps`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ inOracleId: u.out?.oracleId ?? null, outOracleId: u.in.oracleId }),
          })
          if (!undoRes.ok) throw new Error((await undoRes.json()).error ?? 'Undo failed.')
        })
        await load()
      }
    } catch {
      setActionError('Network error applying the swap.')
    } finally {
      setBusyKey(null)
    }
  }

  async function moveHere(u: OccupiedUpgrade, key: string) {
    setBusyKey(key)
    setActionError(null)
    const from = u.usedBy[0]
    try {
      const res = await fetch('/api/collection/move-card', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ oracleId: u.in.oracleId, fromDeckId: from?.id, toDeckId: deckId }),
      })
      const body = await res.json()
      if (!res.ok) setActionError(body.error ?? 'Could not move the card.')
      else {
        if (from) {
          offerUndo(`${u.in.name} moved from ${from.name}`, async () => {
            const undoRes = await fetch('/api/collection/move-card', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ oracleId: u.in.oracleId, fromDeckId: deckId, toDeckId: from.id }),
            })
            if (!undoRes.ok) throw new Error((await undoRes.json()).error ?? 'Undo failed.')
          })
        }
        await load()
      }
    } catch {
      setActionError('Network error moving the card.')
    } finally {
      setBusyKey(null)
    }
  }

  // The pull-list tab is fetched lazily, once.
  useEffect(() => {
    if (tab !== 'pull' || pull !== null || pullBusy) return
    let live = true
    setPullBusy(true)
    setPullError(null)
    fetch(`/api/decks/${deckId}/pull-list`)
      .then((r) => r.json().then((b) => ({ ok: r.ok, b })))
      .then(({ ok, b }) => {
        if (!live) return
        if (!ok) setPullError(b.error ?? 'Could not build the pull list.')
        else setPull(b)
      })
      .catch(() => live && setPullError('Network error building the pull list.'))
      .finally(() => live && setPullBusy(false))
    return () => {
      live = false
    }
  }, [tab, pull, pullBusy, deckId])

  // Apply every selected free upgrade in one go (sequential — each swap depends
  // on the previous deck state), then one re-scan. The whole batch gets a
  // single undo that reverses the applied swaps in reverse order.
  async function applySelected(list: { u: FreeUpgrade; index: number }[]) {
    if (list.length === 0) return
    setBusyKey('bulk')
    setActionError(null)
    const applied: FreeUpgrade[] = []
    try {
      for (const { u } of list) {
        const res = await fetch(`/api/decks/${deckId}/swaps`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ inOracleId: u.in.oracleId, outOracleId: u.out?.oracleId ?? null }),
        })
        if (!res.ok) {
          const body = await res.json()
          setActionError(`Stopped at ${u.in.name}: ${body.error ?? 'swap failed'} (${applied.length} of ${list.length} applied).`)
          break
        }
        applied.push(u)
      }
      if (applied.length > 0) {
        const toReverse = [...applied].reverse()
        offerUndo(`${applied.length} swap${applied.length === 1 ? '' : 's'} applied`, async () => {
          for (const u of toReverse) {
            const res = await fetch(`/api/decks/${deckId}/swaps`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ inOracleId: u.out?.oracleId ?? null, outOracleId: u.in.oracleId }),
            })
            if (!res.ok) throw new Error((await res.json()).error ?? 'Undo failed partway.')
          }
        })
      }
      await load()
    } catch {
      setActionError('Network error while applying swaps.')
    } finally {
      setBusyKey(null)
    }
  }

  // Re-fetch the deck's source URL and replace the composition; the diff shows
  // what changed on Moxfield/Archidekt since the import.
  async function syncDeck() {
    setSyncBusy(true)
    setSyncError(null)
    setSyncResult(null)
    try {
      const res = await fetch(`/api/decks/${deckId}/sync`, { method: 'POST' })
      const body = await res.json()
      if (!res.ok) setSyncError(body.error ?? 'Could not sync the deck.')
      else {
        setSyncResult({ added: body.added ?? [], removed: body.removed ?? [] })
        await load()
      }
    } catch {
      setSyncError('Network error while syncing.')
    } finally {
      setSyncBusy(false)
    }
  }

  // Bridge this collection deck to a PLAYABLE game deck (shows up on /decks).
  async function playThisDeck() {
    setPlayBusy(true)
    setPlayError(null)
    setPlayResult(null)
    try {
      const res = await fetch(`/api/decks/${deckId}/play`, { method: 'POST' })
      const body = await res.json()
      if (!res.ok) setPlayError(body.error ?? 'Could not create the game deck.')
      else setPlayResult({ deckName: body.deckName, missing: body.missing ?? [] })
    } catch {
      setPlayError('Network error creating the game deck.')
    } finally {
      setPlayBusy(false)
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
        <p className="font-rules animate-pulse" style={{ color: 'var(--text-dim)' }}>
          Analysing deck — scoring power and scanning your binder for upgrades…
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

      {sourceUrl ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" style={{ color: 'var(--text-faint)' }}>
          <span>
            Imported from{' '}
            <a href={sourceUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
              {source === 'archidekt' ? 'Archidekt' : source === 'moxfield' ? 'Moxfield' : 'source'} ↗
            </a>
          </span>
          <button onClick={syncDeck} disabled={syncBusy} className="underline underline-offset-2 disabled:opacity-40" style={{ color: 'var(--gold-bright)' }}>
            {syncBusy ? 'Syncing…' : 'Sync latest changes'}
          </button>
          {syncError ? <span style={{ color: 'var(--danger)' }}>{syncError}</span> : null}
          {syncResult ? (
            <span style={{ color: 'var(--text-dim)' }}>
              {syncResult.added.length === 0 && syncResult.removed.length === 0
                ? 'Already up to date.'
                : [
                    syncResult.added.length > 0 ? `+ ${syncResult.added.map((a) => `${a.qty}× ${a.name}`).join(', ')}` : null,
                    syncResult.removed.length > 0 ? `− ${syncResult.removed.map((r) => `${r.qty}× ${r.name}`).join(', ')}` : null,
                  ]
                    .filter(Boolean)
                    .join('  ·  ')}
            </span>
          ) : null}
        </div>
      ) : null}

      <div>
        <div className="mb-3 flex gap-2">
          <Tab active={tab === 'free'} onClick={() => setTab('free')}>
            Free upgrades ({free.length})
          </Tab>
          <Tab active={tab === 'occupied'} onClick={() => setTab('occupied')}>
            In other decks ({occupied.length})
          </Tab>
          <Tab active={tab === 'buy'} onClick={() => setTab('buy')}>
            Buy
          </Tab>
          <Tab active={tab === 'pull'} onClick={() => setTab('pull')}>
            Pull list
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
            <FreeUpgradesList
              free={free}
              busyKey={busyKey}
              selected={selected}
              setSelected={setSelected}
              onApplyOne={applyFree}
              onApplySelected={applySelected}
            />
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
                    <CardName name={u.in.name} className="font-display text-base" style={{ color: 'var(--text-bright)' }} />
                    <Chip>{u.tag.replace(/_/g, ' ')}</Chip>
                    <ConfidenceBadge value={u.confidence} />
                    <ThemeBadge impact={u.themeImpact} />
                  </div>
                  <p className="font-rules mt-1 text-sm" style={{ color: 'var(--text-dim)' }}>
                    {u.reason}
                  </p>
                  {u.usedBy.length > 0 ? (
                    <div className="mt-1 text-xs" style={{ color: 'var(--text-faint)' }}>
                      🃏 currently in {u.usedBy.map((d) => d.name).join(', ')}
                      {u.action === 'move' ? ' — moving it weakens that deck' : ''}
                    </div>
                  ) : null}
                </div>
                {u.action === 'move' ? (
                  <button
                    onClick={() => moveHere(u, `occ-${i}`)}
                    disabled={busyKey !== null}
                    className="shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-40"
                    style={{ border: '1px solid rgba(217,165,59,0.5)', color: 'var(--warn)' }}
                  >
                    {busyKey === `occ-${i}` ? '…' : `Move from ${truncate(u.usedBy[0]?.name ?? 'other deck', 24)}`}
                  </button>
                ) : (
                  <span className="shrink-0 rounded px-2 py-1 text-xs uppercase tracking-wide" style={{ color: 'var(--text-faint)', border: '1px solid rgba(201,154,58,0.3)' }} title="Every copy you own is in a deck that needs it — buy a copy or proxy">
                    buy a copy
                  </span>
                )}
              </Panel>
            ))}
          </div>
          )
        ) : tab === 'buy' ? (
          <BuyTab buys={buys} busy={buyBusy} error={buyError} budget={buyBudget} setBudget={setBuyBudget} />
        ) : (
          <PullTab pull={pull} busy={pullBusy} error={pullError} />
        )}
      </div>

      {/* Bridge to the game side, AFTER the tuning work area — one click turns this
          collection deck into a playable game deck (visible on /decks and in the
          lobby's deck picker). */}
      <Panel className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-rules text-sm" style={{ color: 'var(--text-dim)' }}>
            Done tuning? Send this deck to the game so you can play it tonight.
          </p>
          <button
            onClick={playThisDeck}
            disabled={playBusy}
            className="rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-40"
            style={{ background: 'linear-gradient(150deg, var(--gold-bright), var(--frame-gold))', color: '#1c1407' }}
          >
            {playBusy ? 'Creating…' : '▶ Play this deck'}
          </button>
        </div>
        {playError ? (
          <p className="mt-2 text-sm" style={{ color: 'var(--danger)' }}>
            {playError}
          </p>
        ) : null}
        {playResult ? (
          <p className="font-rules mt-2 text-sm" style={{ color: 'var(--cast)' }}>
            “{playResult.deckName}” is ready as a game deck — pick it in the lobby or fine-tune it on{' '}
            <a href="/decks" className="underline underline-offset-2">
              the decks page
            </a>
            .
            {playResult.missing.length > 0
              ? ` ${playResult.missing.length} card(s) missing from the game catalog: ${playResult.missing.map((m) => m.name).join(', ')}.`
              : ''}
          </p>
        ) : null}
      </Panel>

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

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

type FreeSort = 'delta' | 'price' | 'confidence'

// The free-upgrades work surface: sortable, multi-selectable, one primary
// action per row and one batch action for the whole selection. Selection is
// tracked by ORIGINAL index so sorting never changes what's selected.
function FreeUpgradesList({
  free,
  busyKey,
  selected,
  setSelected,
  onApplyOne,
  onApplySelected,
}: {
  free: FreeUpgrade[]
  busyKey: string | null
  selected: Set<number>
  setSelected: (s: Set<number>) => void
  onApplyOne: (u: FreeUpgrade, key: string) => void
  onApplySelected: (list: { u: FreeUpgrade; index: number }[]) => void
}) {
  const [sort, setSort] = useState<FreeSort>('delta')

  const rows = free
    .map((u, index) => ({ u, index }))
    .sort((a, b) => {
      if (sort === 'price') return (a.u.in.priceEur ?? 0) - (b.u.in.priceEur ?? 0)
      if (sort === 'confidence') return b.u.confidence - a.u.confidence
      return b.u.delta - a.u.delta
    })

  const selectedRows = rows.filter((r) => selected.has(r.index))
  const selectedDelta = Math.round(selectedRows.reduce((sum, r) => sum + r.u.delta, 0) * 10) / 10

  function toggle(index: number) {
    const next = new Set(selected)
    if (next.has(index)) next.delete(index)
    else next.add(index)
    setSelected(next)
  }

  function selectConfident() {
    setSelected(new Set(free.map((u, i) => (u.confidence >= 70 ? i : -1)).filter((i) => i >= 0)))
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs" style={{ color: 'var(--text-faint)' }}>
        <span>Sort by</span>
        {(['delta', 'price', 'confidence'] as const).map((key) => (
          <button
            key={key}
            onClick={() => setSort(key)}
            className="rounded-full px-2.5 py-0.5"
            style={sort === key ? { background: 'var(--frame-gold)', color: '#1c1407' } : { border: '1px solid rgba(201,154,58,0.3)', color: 'var(--text-dim)' }}
          >
            {key === 'delta' ? 'impact' : key}
          </button>
        ))}
        <span className="mx-1" aria-hidden>
          ·
        </span>
        <button onClick={selectConfident} className="underline underline-offset-2" style={{ color: 'var(--text-dim)' }}>
          Select all high-confidence
        </button>
        {selected.size > 0 ? (
          <button onClick={() => setSelected(new Set())} className="underline underline-offset-2" style={{ color: 'var(--text-dim)' }}>
            Clear
          </button>
        ) : null}
        {selected.size > 0 ? (
          <button
            onClick={() => onApplySelected(selectedRows)}
            disabled={busyKey !== null}
            className="ml-auto rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-40"
            style={{ background: 'linear-gradient(150deg, var(--gold-bright), var(--frame-gold))', color: '#1c1407' }}
          >
            {busyKey === 'bulk' ? 'Applying…' : `Apply ${selected.size} selected (+${selectedDelta} power)`}
          </button>
        ) : null}
      </div>

      {rows.map(({ u, index }) => (
        <Panel key={index} className="flex items-center justify-between gap-4 p-4">
          <div className="flex min-w-0 items-start gap-3">
            <input
              type="checkbox"
              checked={selected.has(index)}
              onChange={() => toggle(index)}
              className="mt-1.5 h-4 w-4 shrink-0 cursor-pointer"
              style={{ accentColor: 'var(--frame-gold)' }}
              aria-label={`Select ${u.in.name}`}
            />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                {u.out ? (
                  <>
                    <CardName name={u.out.name} className="text-sm line-through" style={{ color: 'var(--text-faint)' }} />
                    <span style={{ color: 'var(--frame-gold)' }}>→</span>
                  </>
                ) : (
                  <span className="text-xs uppercase tracking-wide" style={{ color: 'var(--cast)' }}>
                    add
                  </span>
                )}
                <CardName name={u.in.name} className="font-display text-base" style={{ color: 'var(--text-bright)' }} />
                <Chip>{u.tag.replace(/_/g, ' ')}</Chip>
                <ConfidenceBadge value={u.confidence} />
                <ThemeBadge impact={u.themeImpact} />
              </div>
              <p className="font-rules mt-1 text-sm" style={{ color: 'var(--text-dim)' }}>
                {u.reason}
              </p>
              <BinderTag names={u.binderNames} />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <div className="text-right">
              <div className="font-display text-lg" style={{ color: 'var(--cast)' }}>
                +{u.delta}
              </div>
              <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
                power
              </div>
              {u.in.priceEur != null ? (
                <div className="text-xs" style={{ color: 'var(--text-faint)' }}>
                  €{u.in.priceEur.toFixed(2)}
                </div>
              ) : null}
            </div>
            <button
              onClick={() => onApplyOne(u, `free-${index}`)}
              disabled={busyKey !== null}
              className="rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-40"
              style={{ background: 'linear-gradient(150deg, var(--gold-bright), var(--frame-gold))', color: '#1c1407' }}
            >
              {busyKey === `free-${index}` ? '…' : u.out ? 'Apply' : 'Add'}
            </button>
          </div>
        </Panel>
      ))}
    </div>
  )
}

// The physical gathering checklist: binder → alphabetical, plus what can't be
// pulled (locked in another deck, or simply not owned free).
function PullTab({ pull, busy, error }: { pull: PullList | null; busy: boolean; error: string | null }) {
  if (busy) return <Empty>Walking your binders…</Empty>
  if (error) return <Empty>{error}</Empty>
  if (!pull) return <Empty>Open this tab to build the pull list.</Empty>
  if (pull.groups.length === 0 && pull.missing.length === 0) return <Empty>Nothing to pull.</Empty>
  return (
    <div className="space-y-3">
      {pull.groups.map((g) => (
        <Panel key={g.binder} className="p-4">
          <h4 className="font-display text-sm" style={{ color: 'var(--gold-bright)' }}>
            📒 {g.binder}
            <span className="ml-2 text-xs" style={{ color: 'var(--text-faint)' }}>
              {g.cards.reduce((n, c) => n + c.need, 0)} cards
            </span>
          </h4>
          <ul className="font-rules mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2" style={{ color: 'var(--text)' }}>
            {g.cards.map((c, i) => (
              <li key={i}>
                {c.need > 1 ? `${c.need}× ` : ''}
                <CardName name={c.name} />
              </li>
            ))}
          </ul>
        </Panel>
      ))}
      {pull.missing.length > 0 ? (
        <Panel className="p-4">
          <h4 className="font-display text-sm" style={{ color: 'var(--warn)' }}>
            Not in a binder ({pull.missing.length})
          </h4>
          <ul className="font-rules mt-2 space-y-1 text-sm" style={{ color: 'var(--text-dim)' }}>
            {pull.missing.map((m, i) => (
              <li key={i}>
                {m.need > 1 ? `${m.need}× ` : ''}
                {m.name}
                {m.inDecks.length > 0 ? (
                  <span style={{ color: 'var(--text-faint)' }}> — in {m.inDecks.join(', ')}</span>
                ) : (
                  <span style={{ color: 'var(--text-faint)' }}> — not owned loose (buy or proxy)</span>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
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
  const [copied, setCopied] = useState(false)
  const [sort, setSort] = useState<'fit' | 'price'>('fit')
  const totalEur = (buys ?? []).reduce((sum, b) => sum + (b.priceEur ?? 0), 0)
  // 'fit' keeps the server's ranking; 'price' answers "cheapest wins first".
  const sorted = sort === 'fit' ? (buys ?? []) : [...(buys ?? [])].sort((a, b) => (a.priceEur ?? Infinity) - (b.priceEur ?? Infinity))

  // Shopping-list export: plain "1 Name" lines — pastes into Moxfield, a
  // webshop basket, or your notes for the card shop.
  async function copyList() {
    if (!buys || buys.length === 0) return
    await navigator.clipboard.writeText(buys.map((b) => `1 ${b.name}`).join('\n'))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
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
        {buys && buys.length > 0 ? (
          <>
            <span className="mx-1 text-xs" style={{ color: 'var(--text-faint)' }} aria-hidden>
              ·
            </span>
            {(['fit', 'price'] as const).map((key) => (
              <button
                key={key}
                onClick={() => setSort(key)}
                className="rounded-full px-2.5 py-0.5 text-xs"
                style={sort === key ? { background: 'var(--frame-gold)', color: '#1c1407' } : { border: '1px solid rgba(201,154,58,0.3)', color: 'var(--text-dim)' }}
              >
                {key === 'fit' ? 'best fit' : 'cheapest'}
              </button>
            ))}
            <button
              onClick={copyList}
              className="ml-auto rounded-lg px-3 py-1.5 text-xs font-medium"
              style={{ border: '1px solid rgba(201,154,58,0.4)', color: 'var(--text)' }}
              title="Copy as a decklist-style shopping list"
            >
              {copied ? 'Copied ✓' : `Copy list${totalEur > 0 ? ` (≈€${totalEur.toFixed(2)})` : ''}`}
            </button>
          </>
        ) : null}
      </div>

      {busy ? (
        <Empty>Searching the card pool…</Empty>
      ) : error ? (
        <Empty>{error}</Empty>
      ) : !buys || buys.length === 0 ? (
        <Empty>No purchase suggestions for this deck&apos;s needs within the budget.</Empty>
      ) : (
        <div className="space-y-2">
          {sorted.map((b) => (
            <Panel key={b.oracleId} className="flex items-center justify-between gap-4 p-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <CardName name={b.name} className="font-display text-base" style={{ color: 'var(--text-bright)' }} />
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
