'use client'

import { useState } from 'react'
import { getErrorMessage } from '@/lib/game/actions'

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
  handCards: { id: string; name: string }[]
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
      <div className="w-full max-w-md rounded-xl border border-white/10 bg-[#181C28] p-4">
        <p className="text-base font-black text-white">Opening hand</p>
        {mulligans > 0 && (
          <p className="mt-1 text-xs text-slate-400">
            Select {mulligans} card{mulligans === 1 ? '' : 's'} to put on the bottom of your
            library.
          </p>
        )}
        <div className="mt-3 flex max-h-[50vh] flex-wrap gap-2 overflow-y-auto">
          {handCards.map((card) => {
            const selected = selectedIds.includes(card.id)
            return (
              <button
                key={card.id}
                type="button"
                disabled={busy || mulligans === 0}
                onClick={() => toggleSelected(card.id)}
                className={`rounded-xl border px-3 py-1.5 text-xs font-bold transition active:scale-95 ${
                  selected
                    ? 'border-amber-400 bg-amber-400/20 text-amber-200'
                    : 'border-white/10 bg-slate-800 text-slate-200'
                } ${mulligans === 0 ? '' : 'cursor-pointer'} disabled:opacity-70`}
              >
                {card.name}
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
