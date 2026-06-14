'use client'

import { useState } from 'react'

// ─── Controller Coach Overlay ─────────────────────────────────────────────────
// A short, skippable first-run intro for the phone controller — the only in-game
// onboarding for couch-play guests who've never used the app. Shown once (the
// parent persists "seen" in localStorage) and re-openable via the ? in the status
// bar. Presentational: the parent owns visibility + persistence.

type Slide = { icon: string; title: string; body: string }

const SLIDES: Slide[] = [
  {
    icon: '👋',
    title: 'This is your controller',
    body: 'Your phone is your private hand and controls. The shared board — everyone’s battlefield and life totals — is on the big screen.',
  },
  {
    icon: '🃏',
    title: 'Play your cards',
    body: 'Your hand runs along the bottom. Tap any card to open it, then cast it, attack, or use its abilities.',
  },
  {
    icon: '🔵',
    title: 'Mana is automatic',
    body: 'Tap a land to add mana. When you cast a spell, the app taps your lands and pays the cost for you.',
  },
  {
    icon: '⏭️',
    title: 'The game flows itself',
    body: 'Priority skips through empty steps automatically — you won’t tap through nothing. You’re stopped whenever there’s a real choice. Tune it under “Auto”.',
  },
  {
    icon: '✅',
    title: 'You’re ready',
    body: 'Opponents are up top, your battlefield in the middle, your hand at the bottom. Tap the ? in the top bar to see this again anytime.',
  },
]

export function ControllerCoachOverlay({ onClose }: { onClose: () => void }) {
  const [index, setIndex] = useState(0)
  const slide = SLIDES[index]
  const isLast = index === SLIDES.length - 1

  return (
    <div className="absolute inset-0 z-[80] flex items-center justify-center bg-black/85 p-4" role="dialog" aria-label="How to use your controller">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#181C28] p-6">
        <div className="flex items-start justify-between">
          <span className="text-4xl" aria-hidden>{slide.icon}</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-xs font-bold text-slate-500 transition active:scale-95 hover:text-slate-300"
          >
            Skip
          </button>
        </div>

        <p className="mt-4 text-xl font-black text-white">{slide.title}</p>
        <p className="mt-2 text-sm leading-relaxed text-slate-300">{slide.body}</p>

        {/* Progress dots */}
        <div className="mt-6 flex items-center gap-1.5">
          {SLIDES.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all ${
                i === index ? 'w-5 bg-[#5EE6C7]' : 'w-1.5 bg-white/15'
              }`}
            />
          ))}
        </div>

        <div className="mt-6 flex gap-2">
          {index > 0 && (
            <button
              type="button"
              onClick={() => setIndex((i) => i - 1)}
              className="rounded-xl border border-white/10 px-4 py-2.5 text-sm font-bold text-slate-300 transition active:scale-95"
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={() => (isLast ? onClose() : setIndex((i) => i + 1))}
            className="flex-1 rounded-xl bg-[#5EE6C7] px-4 py-2.5 text-sm font-black text-[#0F1117] transition active:scale-95"
          >
            {isLast ? 'Got it' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )
}
