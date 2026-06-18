'use client'

import { useState } from 'react'
import { getErrorMessage } from '@/lib/game/actions'
import MotionCard from '../MotionCard'

// ─── Opening Hand Overlay ─────────────────────────────────────────────────────
// Full-screen overlay shown during the opening-hand phase (after "Start game",
// before every player has kept). Drives the London mulligan: mulligan redraws
// seven; keeping puts `bottomCount` cards on the bottom of the library. Standard
// = one per mulligan; Commander's first mulligan is free, so bottomCount is
// mulligans-1 (the engine enforces the same). Tap a card to zoom it.

type HandCard = { id: string; name: string; image_url?: string | null }

export function OpeningHandOverlay({
  handCards,
  mulligans,
  bottomCount = mulligans,
  waitingFor,
  onKeep,
  onMulligan,
  kept,
}: {
  handCards: HandCard[]
  mulligans: number
  /** Cards to put on the bottom on keep. Defaults to `mulligans` (London); V5
   *  passes mulligans-1 for Commander's free first mulligan. */
  bottomCount?: number
  waitingFor: string[]
  onKeep: (bottomIds: string[]) => Promise<void>
  onMulligan: () => Promise<void>
  kept: boolean
}) {
  // Cards chosen to go on the BOTTOM of the library (only when bottomCount > 0).
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [zoomed, setZoomed] = useState<HandCard | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      // The hand is redrawn after a mulligan — stale selections must not linger.
      setSelectedIds([])
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  if (kept) {
    return (
      <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/85 p-4">
        <div className="w-full max-w-md rounded-xl border border-white/10 bg-[#181C28] px-4 py-3 text-center">
          <p className="text-sm font-bold text-slate-200">
            Waiting for {waitingFor.join(', ')} to keep…
          </p>
        </div>
      </div>
    )
  }

  const toggleSelected = (cardId: string) => {
    setSelectedIds((prev) =>
      prev.includes(cardId)
        ? prev.filter((id) => id !== cardId)
        : prev.length < bottomCount
          ? [...prev, cardId]
          : prev,
    )
  }

  const keepReady = bottomCount === 0 || selectedIds.length === bottomCount

  return (
    <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/85 p-4">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-xl border border-white/10 bg-[#181C28] p-4">
        <p className="shrink-0 text-base font-black text-white">Opening hand</p>
        <p className="mt-1 shrink-0 text-xs text-slate-400">
          {bottomCount > 0
            ? `Tap a card to zoom. Mark ${bottomCount} card${bottomCount === 1 ? '' : 's'} to put on the bottom of your library.`
            : 'Tap a card to zoom.'}
        </p>
        <div className="mt-3 flex min-h-0 flex-1 flex-wrap content-start justify-center gap-3 overflow-y-auto">
          {handCards.map((card) => {
            const selected = selectedIds.includes(card.id)
            return (
              <div key={card.id} className="relative w-24 shrink-0">
                <button
                  type="button"
                  onClick={() => setZoomed(card)}
                  title={`${card.name} — tap to zoom`}
                  className={`block w-full rounded-lg transition active:scale-95 ${
                    selected ? 'ring-2 ring-amber-400 ring-offset-2 ring-offset-[#181C28]' : ''
                  }`}
                >
                  <MotionCard
                    card={{ id: card.id, name: card.name, image_url: card.image_url, zone: 'hand' }}
                    size="board"
                    useLayoutId={false}
                    className={selected ? 'opacity-90' : undefined}
                  />
                </button>
                {selected && (
                  <span className="pointer-events-none absolute -right-1.5 -top-1.5 rounded-full bg-amber-400 px-1.5 py-0.5 text-[9px] font-black text-amber-950 shadow ring-1 ring-black/40">
                    Bottom
                  </span>
                )}
                {bottomCount > 0 && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => toggleSelected(card.id)}
                    className={`mt-1 w-full rounded-md px-2 py-1 text-[10px] font-bold transition active:scale-95 disabled:opacity-50 ${
                      selected ? 'bg-amber-400 text-amber-950' : 'bg-slate-700 text-slate-200 hover:bg-slate-600'
                    }`}
                  >
                    {selected ? 'On bottom ✓' : 'Put on bottom'}
                  </button>
                )}
              </div>
            )
          })}
        </div>
        <div className="mt-4 flex shrink-0 gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => { void run(onMulligan) }}
            className="flex-1 rounded-xl bg-slate-700 px-4 py-2.5 text-sm font-bold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Mulligan ({mulligans + 1})
          </button>
          <button
            type="button"
            disabled={busy || !keepReady}
            onClick={() => { void run(() => onKeep(selectedIds)) }}
            className="flex-1 rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-bold text-emerald-950 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {bottomCount === 0 ? 'Keep hand' : `Keep — put ${bottomCount} on the bottom`}
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
      </div>

      {/* Card zoom */}
      {zoomed && (
        <div
          className="absolute inset-0 z-[80] flex items-center justify-center bg-black/80 p-8 backdrop-blur-sm"
          onClick={() => setZoomed(null)}
        >
          <div className="w-64 max-w-[80vw]" onClick={(e) => e.stopPropagation()}>
            <MotionCard
              card={{ id: zoomed.id, name: zoomed.name, image_url: zoomed.image_url, zone: 'hand' }}
              size="board"
              useLayoutId={false}
            />
          </div>
        </div>
      )}
    </div>
  )
}
