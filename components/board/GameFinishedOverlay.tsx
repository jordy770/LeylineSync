'use client'

import Link from 'next/link'
import { motion } from 'framer-motion'
import type { GameSessionPlayer } from '@/lib/game/types'

// Victory curtain shown when the session has finished. A single survivor is the
// winner; a wiped-out table (winnerPlayerId null) is a draw. Reuses the board's
// gold/leyline aesthetic. Pass currentPlayerId on the controller to personalise
// it ("You win" / "Defeat") from that player's perspective.
export default function GameFinishedOverlay({
  winnerPlayerId,
  players,
  currentPlayerId,
}: {
  winnerPlayerId: string | null
  players: GameSessionPlayer[]
  currentPlayerId?: string | null
}) {
  const winner = winnerPlayerId
    ? players.find((p) => p.player_id === winnerPlayerId) ?? null
    : null
  const isDraw = !winnerPlayerId
  const winnerName = winner
    ? winner.username || `Player ${winner.seat_number}`
    : null
  // Personalised perspective for the controller view.
  const didWin = Boolean(currentPlayerId) && winnerPlayerId === currentPlayerId
  const didLose = Boolean(currentPlayerId) && !isDraw && !didWin

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
      className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/85 px-6 backdrop-blur-sm"
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_30%,rgba(201,154,58,0.18),transparent_55%)]" />
      <motion.div
        initial={{ opacity: 0, scale: 0.9, y: 24 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 260, damping: 24, delay: 0.1 }}
        className="leyline-glass-panel relative w-full max-w-lg overflow-hidden rounded-2xl p-10 text-center"
      >
        <div className="pointer-events-none absolute inset-x-10 top-0 h-px bg-amber-200/60 shadow-[0_0_24px_rgba(240,206,120,0.6)]" />

        {isDraw ? (
          <>
            <p className="text-6xl">⚔️</p>
            <p className="mt-4 text-xs font-semibold uppercase tracking-[0.3em] text-slate-400">
              Game over
            </p>
            <h2 className="font-display mt-2 text-4xl font-bold text-slate-100">
              Draw
            </h2>
            <p className="mt-3 text-sm text-slate-400">
              The last players fell together — no survivor remains.
            </p>
          </>
        ) : didLose ? (
          <>
            <p className="text-6xl">💀</p>
            <p className="mt-4 text-xs font-semibold uppercase tracking-[0.3em] text-slate-400">
              Defeat
            </p>
            <h2 className="font-display mt-2 text-4xl font-bold text-slate-300">
              {winnerName} wins
            </h2>
            <p className="mt-3 text-sm text-slate-400">
              You have fallen — better luck next leyline.
            </p>
          </>
        ) : (
          <>
            <motion.p
              initial={{ scale: 0, rotate: -30 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ type: 'spring', stiffness: 200, damping: 12, delay: 0.25 }}
              className="text-6xl"
            >
              👑
            </motion.p>
            <p className="mt-4 text-xs font-semibold uppercase tracking-[0.3em] text-amber-300/90">
              Victory
            </p>
            <h2 className="font-display mt-2 bg-gradient-to-b from-amber-100 via-amber-300 to-amber-500 bg-clip-text text-4xl font-bold text-transparent">
              {didWin ? 'You win!' : winnerName}
            </h2>
            <p className="mt-3 text-sm text-slate-400">
              {didWin ? 'You are the last leyliner standing.' : 'is the last leyliner standing.'}
            </p>
          </>
        )}

        <Link
          href="/protected"
          className="mt-8 inline-flex items-center justify-center rounded-lg border border-amber-300/40 bg-amber-500/10 px-6 py-2.5 text-sm font-semibold text-amber-100 transition-colors hover:bg-amber-500/20"
        >
          Back to lobby
        </Link>
      </motion.div>
    </motion.div>
  )
}
