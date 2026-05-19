'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getErrorMessage } from './actions'
import {
  getControllerCards,
  getGameActionLogs,
  getGameSession,
  getGameSessionPlayers,
  getPlayerManaPool,
  getTurnState,
} from './data'
import { enableFallbackRefresh, fallbackRefreshIntervalMs } from './dev'
import { buildPlayerJudgeStats, type PlayerJudgeStats } from './judge-selectors'
import type { GameActionLog, GameSessionPlayer, GameTurnState } from './types'

export function useJudgeGameState(sessionId: string) {
  const supabase = useMemo(() => createClient(), [])
  const [sessionStatus, setSessionStatus] = useState<string>('loading')
  const [sessionPlayers, setSessionPlayers] = useState<GameSessionPlayer[]>([])
  const [turnState, setTurnState] = useState<GameTurnState | null>(null)
  const [actionLogs, setActionLogs] = useState<GameActionLog[]>([])
  const [playerStats, setPlayerStats] = useState<Record<string, PlayerJudgeStats>>({})
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [session, players, nextTurnState, nextActionLogs] = await Promise.all([
        getGameSession(supabase, sessionId),
        getGameSessionPlayers(supabase, sessionId),
        getTurnState(supabase, sessionId),
        getGameActionLogs(supabase, sessionId),
      ])

      const statsEntries = await Promise.all(
        players.map(async (player) => {
          const [result, manaPool] = await Promise.all([
            getControllerCards(supabase, sessionId, player.player_id),
            getPlayerManaPool(supabase, sessionId, player.player_id),
          ])

          return [player.player_id, buildPlayerJudgeStats(result.cards, manaPool)] as const
        }),
      )

      setSessionStatus(session?.status ?? 'missing')
      setSessionPlayers(players)
      setTurnState(nextTurnState)
      setActionLogs(nextActionLogs)
      setPlayerStats(Object.fromEntries(statsEntries))
      setErrorMessage(null)
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to load judge context:', message, error)
      setErrorMessage(message)
    }
  }, [sessionId, supabase])

  useEffect(() => {
    refresh()

    const channel = supabase
      .channel(`judge:${sessionId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_sessions', filter: `id=eq.${sessionId}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_cards', filter: `session_id=eq.${sessionId}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_players', filter: `session_id=eq.${sessionId}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_session_players', filter: `session_id=eq.${sessionId}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_turn_state', filter: `session_id=eq.${sessionId}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_action_log', filter: `session_id=eq.${sessionId}` }, refresh)
      .subscribe((status, error) => {
        console.log('Judge realtime status:', status)
        if (error) {
          console.error('Judge realtime error:', error)
        }
      })

    const refreshInterval = enableFallbackRefresh
      ? window.setInterval(refresh, fallbackRefreshIntervalMs)
      : null

    return () => {
      if (refreshInterval) {
        window.clearInterval(refreshInterval)
      }
      supabase.removeChannel(channel)
    }
  }, [refresh, sessionId, supabase])

  return {
    sessionStatus,
    sessionPlayers,
    turnState,
    actionLogs,
    playerStats,
    errorMessage,
    refresh,
  }
}
