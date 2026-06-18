'use client'

/**
 * Throwaway lab route for feeling the HandFan interaction on a phone.
 * Not part of the real controller — just a sandbox.
 *
 *   collapsed → tap the fan to raise it; tap outside to retract
 *   drag a card sideways → reorder
 *   drag a card up into the cast zone → "play" it (logged here)
 *   tap a card → open its details (zoom)
 *
 * `playable` + `showPlayability` drive the amber ring / dim cues — a few demo
 * cards below are marked unplayable to show the dimming.
 *
 * Cards use MotionCard's name fallback (no images needed). Add an
 * `image_url` (cards.scryfall.io) to any card to render real art.
 */

import { useState } from 'react'
import HandFan, { type HandFanCard } from '@/components/controller/HandFan'

const DEMO_HAND: HandFanCard[] = [
  { id: 'c1', name: 'Lightning Bolt', image_url: null, showPlayability: true, playable: true },
  { id: 'c2', name: 'Llanowar Elves', image_url: null, showPlayability: true, playable: false },
  { id: 'c3', name: 'Counterspell', image_url: null, showPlayability: true, playable: true },
  { id: 'c4', name: 'Wrath of God', image_url: null, showPlayability: true, playable: false },
  { id: 'c5', name: 'Birds of Paradise', image_url: null, showPlayability: true, playable: true },
  { id: 'c6', name: 'Sol Ring', image_url: null, showPlayability: true, playable: true },
  { id: 'c7', name: 'Cultivate', image_url: null, showPlayability: true, playable: false },
]

export default function ControllerStyleLab() {
  // Bump the key to remount + reset any local reordering.
  const [resetKey, setResetKey] = useState(0)
  const [log, setLog] = useState<string>('')

  return (
    <main className="relative h-[100dvh] w-full overflow-hidden bg-[#070811] text-slate-200">
      {/* Fake board backdrop so the fan has something to sit over */}
      <div className="pointer-events-none absolute inset-0 flex flex-col gap-3 p-4 opacity-60">
        <div className="flex gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-24 flex-1 rounded-lg border border-[#1E2230] bg-[#0C0E14]" />
          ))}
        </div>
        <div className="flex gap-2">
          {[0, 1].map((i) => (
            <div key={i} className="h-16 flex-1 rounded-lg border border-[#1E2230] bg-[#0C0E14]" />
          ))}
        </div>
        <div className="mt-auto flex gap-1.5">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-12 flex-1 rounded border border-[#1E2230] bg-[#0C0E14]" />
          ))}
        </div>
      </div>

      <div className="absolute left-4 top-4 z-40 flex items-center gap-2">
        <span className="rounded-md bg-black/40 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          HandFan lab
        </span>
        <button
          type="button"
          onClick={() => {
            setResetKey((k) => k + 1)
            setLog('')
          }}
          className="rounded-md border border-white/15 bg-white/5 px-2.5 py-1 text-[11px] font-semibold text-slate-300 active:scale-95"
        >
          Reset hand
        </button>
        {log && <span className="text-[11px] text-amber-300">{log}</span>}
      </div>

      <HandFan
        key={resetKey}
        cards={DEMO_HAND}
        onSelect={(c) => setLog(`Opened ${c.name}`)}
        onCast={(c) => setLog(`Played ${c.name}`)}
      />
    </main>
  )
}
