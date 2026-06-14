'use client'

import { useState } from 'react'
import { getErrorMessage } from '@/lib/game/actions'
import MotionCard from '../MotionCard'

// ─── Opening Hand Overlay ─────────────────────────────────────────────────────
// Full-screen overlay shown during the opening-hand phase (after "Start game",
// before every player has kept). Drives the London mulligan: mulligan redraws
// seven, keeping after N mulligans requires choosing exactly N cards to put on
// the bottom of the library.

export function OpeningHandOverlay({
  handCards,
  mulligans,
  waitingFor,
  onKeep,
  onMulligan,
  kept,
}: {
  handCards: { id: string; name: string; image_url?: string | null }[]
  mulligans: number
  waitingFor: string[]
  onKeep: (bottomIds: string[]) => Promise<void>
  onMulligan: () => Promise<void>
  kept: boolean
}) {
  // Cards chosen to go on the BOTTOM of the library (only when mulligans > 0).
  const [selectedIds, setSelectedIds] = useState<string[]>([])
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
        : prev.length < mulligans
          ? [...prev, cardId]
          : prev,
    )
  }

  const keepReady = mulligans === 0 || selectedIds.length === mulligans

  return (
    <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/85 p-4">
      <div className="w-full max-w-4xl rounded-xl border border-white/10 bg-[#181C28] p-4">
        <p className="text-base font-black text-white">Opening hand</p>
        {mulligans > 0 && (
          <p className="mt-1 text-xs text-slate-400">
            Tap {mulligans} card{mulligans === 1 ? '' : 's'} to put on the bottom of your
            library.
          </p>
        )}
        <div className="mt-3 flex max-h-[55vh] flex-wrap justify-center gap-3 overflow-y-auto">
          {handCards.map((card) => {
            const selected = selectedIds.includes(card.id)
            return (
              <button
                key={card.id}
                type="button"
                disabled={busy || mulligans === 0}
                onClick={() => toggleSelected(card.id)}
                title={card.name}
                className={`relative w-24 shrink-0 rounded-lg transition active:scale-95 disabled:cursor-default ${
                  selected ? 'ring-2 ring-amber-400 ring-offset-2 ring-offset-[#181C28]' : ''
                } ${mulligans === 0 ? '' : 'cursor-pointer'}`}
              >
                <MotionCard
                  card={{ id: card.id, name: card.name, image_url: card.image_url, zone: 'hand' }}
                  size="board"
                  useLayoutId={false}
                  className={selected ? 'opacity-90' : undefined}
                />
                {selected && (
                  <span className="absolute -right-1.5 -top-1.5 rounded-full bg-amber-400 px-1.5 py-0.5 text-[9px] font-black text-amber-950 shadow ring-1 ring-black/40">
                    Bottom
                  </span>
                )}
              </button>
            )
          })}
        </div>
        <div className="mt-4 flex gap-2">
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
            {mulligans === 0 ? 'Keep hand' : `Keep — put ${mulligans} on the bottom`}
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
      </div>
    </div>
  )
}
