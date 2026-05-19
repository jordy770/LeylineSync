'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  getBoardCards,
  getCombatAssignments,
  getGameSessionPlayers,
  getStackItems,
  getTurnState,
} from './data'
import { enableFallbackRefresh, fallbackRefreshIntervalMs } from './dev'
import type {
  BoardCard,
  CombatAssignment,
  GameSessionPlayer,
  GameTurnState,
  StackItem,
} from './types'

export function useBoardGameState(sessionId: string) {
  const supabase = useMemo(() => createClient(), [])
  const [cards, setCards] = useState<BoardCard[]>([])
  const [players, setPlayers] = useState<GameSessionPlayer[]>([])
  const [turnState, setTurnState] = useState<GameTurnState | null>(null)
  const [combatAssignments, setCombatAssignments] = useState<CombatAssignment[]>([])
  const [stackItems, setStackItems] = useState<StackItem[]>([])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [boardCards, sessionPlayers, nextTurnState, nextCombatAssignments, nextStackItems] =
        await Promise.all([
          getBoardCards(supabase, sessionId),
          getGameSessionPlayers(supabase, sessionId),
          getTurnState(supabase, sessionId),
          getCombatAssignments(supabase, sessionId),
          getStackItems(supabase, sessionId),
        ])

      setErrorMessage(null)
      setCards(boardCards)
      setPlayers(sessionPlayers)
      setTurnState(nextTurnState)
      setCombatAssignments(nextCombatAssignments)
      setStackItems(nextStackItems)
    } catch (error) {
      console.error('Failed to fetch board state:', error)
      setErrorMessage(error instanceof Error ? error.message : 'Could not load board state')
    }
  }, [sessionId, supabase])

  useEffect(() => {
    refresh()

    const channel = supabase
      .channel(`board:${sessionId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_cards', filter: `session_id=eq.${sessionId}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cards' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_turn_state', filter: `session_id=eq.${sessionId}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_session_players', filter: `session_id=eq.${sessionId}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_combat_assignments', filter: `session_id=eq.${sessionId}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_combat_blockers' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_stack_items', filter: `session_id=eq.${sessionId}` }, refresh)
      .subscribe((status, error) => {
        console.log('Board realtime status:', status)
        if (error) {
          console.error('Board realtime error:', error)
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
    cards,
    players,
    turnState,
    combatAssignments,
    stackItems,
    errorMessage,
    refresh,
  }
}
