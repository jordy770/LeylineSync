'use client'

import { HeartPulse, Minus, Plus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { adjustPlayerLife, getErrorMessage } from '@/lib/game/actions'
import { getGameSession, getGameSessionPlayers } from '@/lib/game/data'
import { enableFallbackRefresh, fallbackRefreshIntervalMs } from '@/lib/game/dev'
import { createClient } from '@/lib/supabase/client'
import type { GameSessionPlayer } from '@/lib/game/types'

export default function LifeTotalsPanel({ sessionId }: { sessionId: string }) {
  const supabase = useMemo(() => createClient(), [])
  const [players, setPlayers] = useState<GameSessionPlayer[]>([])
  const [isSessionFinished, setIsSessionFinished] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [pendingPlayerId, setPendingPlayerId] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true

    const loadPlayers = async () => {
      try {
        const [session, sessionPlayers] = await Promise.all([
          getGameSession(supabase, sessionId),
          getGameSessionPlayers(supabase, sessionId),
        ])

        if (isMounted) {
          setIsSessionFinished(session?.status === 'finished')
          setPlayers(sessionPlayers)
          setErrorMessage(null)
        }
      } catch (error) {
        const message = getErrorMessage(error)
        console.error('Failed to load life totals:', message, error)
        if (isMounted) {
          setErrorMessage(message)
        }
      }
    }

    loadPlayers()

    const channel = supabase
      .channel(`life-totals:${sessionId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_session_players',
          filter: `session_id=eq.${sessionId}`,
        },
        loadPlayers,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_sessions',
          filter: `id=eq.${sessionId}`,
        },
        loadPlayers,
      )
      .subscribe((status, error) => {
        console.log('Life totals realtime status:', status)
        if (error) {
          console.error('Life totals realtime error:', error)
        }
      })

    const refreshInterval = enableFallbackRefresh ? window.setInterval(loadPlayers, fallbackRefreshIntervalMs) : null

    return () => {
      isMounted = false
      if (refreshInterval) {
        window.clearInterval(refreshInterval)
      }
      supabase.removeChannel(channel)
    }
  }, [sessionId, supabase])

  const handleAdjustLife = async (targetPlayerId: string, delta: number) => {
    setErrorMessage(null)
    setPendingPlayerId(targetPlayerId)

    try {
      await adjustPlayerLife(supabase, sessionId, targetPlayerId, delta)
      const sessionPlayers = await getGameSessionPlayers(supabase, sessionId)
      setPlayers(sessionPlayers)
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to adjust life total:', message, error)
      setErrorMessage(message)
    } finally {
      setPendingPlayerId(null)
    }
  }

  return (
    <section className="mb-5 rounded-lg border border-slate-800 bg-slate-950 p-4">
      <div className="mb-3 flex items-center gap-2">
        <HeartPulse className="h-4 w-4 text-red-300" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-white">Life Totals</h2>
      </div>
      {isSessionFinished ? (
        <p className="mb-3 text-xs text-slate-500">Game is finished. Life totals are locked.</p>
      ) : null}

      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        {players.map((player) => {
          const isPending = pendingPlayerId === player.player_id

          return (
            <div key={player.player_id} className="rounded-md bg-slate-900 p-3">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-white">
                    {player.username || `Player ${player.player_id.slice(0, 8)}`}
                  </p>
                  <p className="text-xs text-slate-500">Seat {player.seat_number}</p>
                </div>
                <p className="text-2xl font-bold text-white">{player.life_total}</p>
              </div>

              <div className="grid grid-cols-4 gap-2">
                <LifeButton
                  label="-5"
                  disabled={isPending || isSessionFinished}
                  onClick={() => handleAdjustLife(player.player_id, -5)}
                />
                <LifeButton
                  label="-1"
                  disabled={isPending || isSessionFinished}
                  onClick={() => handleAdjustLife(player.player_id, -1)}
                />
                <LifeButton
                  label="+1"
                  disabled={isPending || isSessionFinished}
                  onClick={() => handleAdjustLife(player.player_id, 1)}
                />
                <LifeButton
                  label="+5"
                  disabled={isPending || isSessionFinished}
                  onClick={() => handleAdjustLife(player.player_id, 5)}
                />
              </div>
            </div>
          )
        })}
      </div>

      {errorMessage ? <p className="mt-3 text-xs text-red-300">{errorMessage}</p> : null}
    </section>
  )
}

function LifeButton({
  label,
  disabled,
  onClick,
}: {
  label: string
  disabled: boolean
  onClick: () => void
}) {
  const isIncrease = label.startsWith('+')

  return (
    <button
      type="button"
      title={isIncrease ? `Gain ${label.slice(1)} life` : `Lose ${label.slice(1)} life`}
      aria-label={isIncrease ? `Gain ${label.slice(1)} life` : `Lose ${label.slice(1)} life`}
      onClick={onClick}
      disabled={disabled}
      className="flex h-9 items-center justify-center gap-1 rounded-md bg-white px-2 text-xs font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {isIncrease ? (
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <Minus className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      <span>{label.slice(1)}</span>
    </button>
  )
}
