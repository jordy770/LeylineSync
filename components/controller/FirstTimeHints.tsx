'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useState } from 'react'

// ─── First-time hints ─────────────────────────────────────────────────────────
// Just-in-time onboarding: a one-time dismissible card the first moment each
// core interaction actually happens (your main phase, attacking, blocking, a
// stack you can respond to). Complements the front-loaded coach slides — by the
// time you must block, slide 4 is long forgotten. Seen-flags are global (not
// per session): a guest learns each concept once, ever.

export type HintKey = 'cast' | 'attack' | 'block' | 'stack'

const HINTS: Record<HintKey, { icon: string; title: string; body: string }> = {
  cast: {
    icon: '🃏',
    title: 'Your main phase',
    body: 'Tap a card in your hand to cast it — lands are tapped and mana is paid for you. Tap a land to play it (one per turn).',
  },
  attack: {
    icon: '⚔️',
    title: 'Time to attack',
    body: 'Tap the creatures you want to attack with, then confirm. Creatures with summoning sickness sit this one out.',
  },
  block: {
    icon: '🛡️',
    title: 'You’re being attacked',
    body: 'Tap an incoming attacker, then one of your creatures to block it. Unblocked attackers hit you — confirm when you’re set.',
  },
  stack: {
    icon: '⚡',
    title: 'Something’s on the stack',
    body: 'A spell or ability is waiting to resolve. Respond with an instant from your hand, or pass to let it happen.',
  },
}

const storageKey = (key: HintKey) => `ll_hint_${key}`

export function FirstTimeHints({
  candidate,
  suppressed,
}: {
  /** Which hint the current game state calls for, or null. The parent derives this. */
  candidate: HintKey | null
  /** True while another overlay (coach, opening hand, finished) owns the screen. */
  suppressed: boolean
}) {
  const [active, setActive] = useState<HintKey | null>(null)

  useEffect(() => {
    if (suppressed) return
    // The moment passed (they attacked, the stack resolved…) — the hint goes too.
    if (active && candidate !== active) {
      setActive(null)
      return
    }
    if (!active && candidate && !localStorage.getItem(storageKey(candidate))) {
      localStorage.setItem(storageKey(candidate), '1')
      setActive(candidate)
    }
  }, [candidate, active, suppressed])

  const hint = active ? HINTS[active] : null

  return (
    <AnimatePresence>
      {hint && !suppressed && (
        <motion.button
          type="button"
          initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}
          onClick={() => setActive(null)}
          className="absolute inset-x-3 bottom-40 z-[54] flex items-start gap-2.5 rounded-xl border border-cyan-300/25 bg-[#0E1B22]/95 p-3 text-left shadow-lg backdrop-blur-sm active:scale-[0.99]"
        >
          <span className="shrink-0 text-lg leading-none" aria-hidden>{hint.icon}</span>
          <span className="flex-1">
            <span className="block text-xs font-black text-cyan-200">{hint.title}</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-slate-300">{hint.body}</span>
          </span>
          <span className="shrink-0 text-[10px] font-bold text-slate-400" aria-label="Dismiss">✕</span>
        </motion.button>
      )}
    </AnimatePresence>
  )
}
