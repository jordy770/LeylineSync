'use client'

// Shared, self-contained game-log overlay used by the board view (and reusable by
// any screen). Creates its own Supabase client, fetches the log once, then live-
// updates on game_action_log INSERTs (published mig 330). Render it conditionally
// behind an open flag and pass onClose.

import { createPortal } from 'react-dom'
import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { createClient } from '@/lib/supabase/client'
import { getGameLog, type GameLogEntry } from '@/lib/game/data'
import type { GameSessionPlayer } from '@/lib/game/types'

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h`
}

const ACTION_ACCENT: Record<string, string> = {
  life: 'text-rose-300',
  poison: 'text-lime-300',
  counter: 'text-amber-200',
}

export default function GameLogPanel({
  sessionId,
  players,
  open,
  onClose,
}: {
  sessionId: string
  players: GameSessionPlayer[]
  open: boolean
  onClose: () => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [entries, setEntries] = useState<GameLogEntry[]>([])
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const load = () => getGameLog(supabase, sessionId).then((e) => { if (!cancelled) setEntries(e) }).catch(() => {})
    load()
    const ch = supabase
      .channel(`board-log:${sessionId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'game_action_log', filter: `session_id=eq.${sessionId}` }, load)
      .subscribe()
    return () => { cancelled = true; supabase.removeChannel(ch) }
  }, [open, supabase, sessionId])

  const nameOf = (id: string) => players.find((p) => p.player_id === id)?.username ?? 'Player'

  if (!mounted) return null

  return createPortal(
    <AnimatePresence>
      {open ? (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[80] bg-black/70 backdrop-blur-[2px]" onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, x: 40 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 40 }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className="fixed inset-y-0 right-0 z-[81] flex w-full max-w-md flex-col border-l border-[#1E2230] bg-[#0C0F16]/98 shadow-2xl shadow-black/60"
          >
            <div className="flex shrink-0 items-center justify-between border-b border-[#1E2230] px-5 py-3.5">
              <p className="text-sm font-black tracking-wide text-white">📜 Game log</p>
              <button
                type="button" onClick={onClose}
                className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-bold text-slate-300 transition-colors hover:bg-white/10"
              >
                Close
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              {entries.length === 0 ? (
                <p className="py-10 text-center text-sm text-slate-600">Nothing has happened yet.</p>
              ) : (
                <div className="flex flex-col gap-1">
                  {entries.map((e) => (
                    <div key={e.id} className="flex items-baseline gap-2 rounded-lg px-2 py-1.5 text-sm odd:bg-white/[0.02]">
                      <span className="shrink-0 font-bold text-cyan-200">{nameOf(e.actor_player_id)}</span>
                      <span className={`flex-1 ${ACTION_ACCENT[e.action_type] ?? 'text-slate-200'}`}>{e.description}</span>
                      <span className="shrink-0 font-mono text-[10px] text-slate-600">{timeAgo(e.created_at)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        </>
      ) : null}
    </AnimatePresence>,
    document.body,
  )
}
