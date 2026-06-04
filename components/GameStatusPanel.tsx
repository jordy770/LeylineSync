'use client'

import { Trophy } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { getErrorMessage } from '@/lib/game/actions'
import { getGameSession, getGameSessionPlayers } from '@/lib/game/data'
import { enableFallbackRefresh, fallbackRefreshIntervalMs } from '@/lib/game/dev'
import { createClient } from '@/lib/supabase/client'
import type { GameSession, GameSessionPlayer } from '@/lib/game/types'

export default function GameStatusPanel({ sessionId }: { sessionId: string }) {
  const supabase = useMemo(() => createClient(), [])
  const [session, setSession] = useState<GameSession | null>(null)
  const [players, setPlayers] = useState<GameSessionPlayer[]>([])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true

    const loadStatus = async () => {
      try {
        const [nextSession, nextPlayers] = await Promise.all([
          getGameSession(supabase, sessionId),
          getGameSessionPlayers(supabase, sessionId),
        ])

        if (isMounted) {
          setSession(nextSession)
          setPlayers(nextPlayers)
          setErrorMessage(null)
        }
      } catch (error) {
        const message = getErrorMessage(error)
        console.error('Failed to load game status:', message, error)
        if (isMounted) {
          setErrorMessage(message)
        }
      }
    }

    loadStatus()

    const channel = supabase
      .channel(`game-status:${sessionId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_sessions',
          filter: `id=eq.${sessionId}`,
        },
        loadStatus,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_session_players',
          filter: `session_id=eq.${sessionId}`,
        },
        loadStatus,
      )
      .subscribe((status, error) => {
        console.log('Game status realtime status:', status)
        if (error) {
          console.error('Game status realtime error:', error)
        }
      })

    const refreshInterval = enableFallbackRefresh ? window.setInterval(loadStatus, fallbackRefreshIntervalMs) : null

    return () => {
      isMounted = false
      if (refreshInterval) {
        window.clearInterval(refreshInterval)
      }
      supabase.removeChannel(channel)
    }
  }, [sessionId, supabase])

  if (errorMessage) {
    return <p className="mb-5 text-xs text-red-300">{errorMessage}</p>
  }

  if (!session || session.status !== 'finished') {
    return null
  }

  const winner = session.winner_player_id
    ? players.find((player) => player.player_id === session.winner_player_id)
    : null
  const winnerName = winner
    ? winner.username || `Player ${winner.player_id.slice(0, 8)}`
    : session.winner_player_id
      ? session.winner_player_id.slice(0, 8)
      : 'No winner'

  return (
    <section className="mb-5 rounded-lg border border-emerald-700 bg-emerald-950 p-4 text-emerald-50">
      <div className="flex items-center gap-2">
        <Trophy className="h-4 w-4" aria-hidden="true" />
        <h2 className="text-sm font-semibold">Game Finished</h2>
      </div>
      <p className="mt-2 text-sm">Winner: {winnerName}</p>
    </section>
  )
}
