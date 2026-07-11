'use client'

import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { getGameSession } from '@/lib/game/data'
import { createClient } from '@/lib/supabase/client'

// The lobby footnote made the room code (mig 379) nearly invisible — and once a
// game starts the controller showed it nowhere. This popup puts the code front
// and center from wherever it's opened: TV opens leylinesync.com/tv, types this.
export default function TvCodePopup({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [mounted, setMounted] = useState(false)
  const [code, setCode] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => setMounted(true), [])

  useEffect(() => {
    let cancelled = false
    const supabase = createClient()
    getGameSession(supabase, sessionId)
      .then((session) => {
        if (cancelled) return
        if (session?.tv_code) setCode(session.tv_code)
        else setFailed(true)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  if (!mounted || typeof document === 'undefined') return null

  return createPortal(
    <>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-[80] bg-black/80 backdrop-blur-[2px]" onClick={onClose}
      />
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }}
        transition={{ type: 'spring', damping: 30, stiffness: 350 }}
        className="fixed inset-0 z-[81] flex items-center justify-center p-6"
        onClick={onClose}
      >
        <div
          className="w-full max-w-sm rounded-2xl border border-amber-400/25 bg-slate-950 p-6 text-center shadow-2xl shadow-black/60"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="text-sm font-black text-white">📺 Watch on TV</p>
          <p className="mt-2 text-sm text-slate-400">
            Open <span className="font-semibold text-slate-200">leylinesync.com/tv</span> in the TV&apos;s browser and
            enter this code:
          </p>
          <div className="mt-5 rounded-2xl border border-amber-400/40 bg-amber-500/10 px-4 py-5 font-mono text-5xl font-black tracking-[0.3em] text-amber-300">
            {code ?? (failed ? '—' : '···')}
          </div>
          {failed ? (
            <p className="mt-3 text-xs text-red-300">Couldn&apos;t load the room code — try again in a moment.</p>
          ) : (
            <p className="mt-3 text-xs text-slate-500">Anyone with the code can watch this game (read-only).</p>
          )}
          <button
            type="button"
            onClick={onClose}
            className="mt-5 w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-bold text-slate-300 transition active:scale-95 hover:bg-white/10"
          >
            Close
          </button>
        </div>
      </motion.div>
    </>,
    document.body,
  )
}
