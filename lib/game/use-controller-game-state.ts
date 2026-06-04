'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getErrorMessage } from './actions'
import {
  getActivePumpTotals,
  getBoardCards,
  getCombatActionState,
  getCombatAssignments,
  getControllerCards,
  getCurrentPlayerId,
  getGameSession,
  getGameSessionPlayers,
  getPendingDecisions,
  getPlayerManaPool,
  getStackItems,
  getTurnState,
  normalizeManaPool,
} from './data'
import { enableFallbackRefresh, fallbackRefreshIntervalMs } from './dev'
import type {
  BoardCard,
  CombatActionState,
  CombatAssignment,
  ControllerCard,
  GameSessionPlayer,
  GameTurnState,
  ManaPool,
  PendingDecision,
  StackItem,
} from './types'

export function useControllerGameState(sessionId: string) {
  const supabase = useMemo(() => createClient(), [])
  const [cards, setCards] = useState<ControllerCard[]>([])
  const [boardCards, setBoardCards] = useState<BoardCard[]>([])
  const [players, setPlayers] = useState<GameSessionPlayer[]>([])
  const [turnState, setTurnState] = useState<GameTurnState | null>(null)
  const [combatActionState, setCombatActionState] = useState<CombatActionState | null>(null)
  const [combatAssignments, setCombatAssignments] = useState<CombatAssignment[]>([])
  const [stackItems, setStackItems] = useState<StackItem[]>([])
  const [pendingDecisions, setPendingDecisions] = useState<PendingDecision[]>([])
  const [manaPool, setManaPool] = useState<ManaPool>(() => normalizeManaPool(null))
  const [playerId, setPlayerId] = useState<string | null>(null)
  const [isSessionFinished, setIsSessionFinished] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const loadControllerState = useCallback(async () => {
    try {
      const currentPlayerId = await getCurrentPlayerId(supabase)

      if (!currentPlayerId) {
        setPlayerId(null)
        setCards([])
        setManaPool(normalizeManaPool(null))
        setErrorMessage('No signed-in player found')
        setIsLoading(false)
        return
      }

      const [
        session,
        controllerResult,
        allBoardCards,
        sessionPlayers,
        nextTurnState,
        nextCombatActionState,
        nextCombatAssignments,
        nextStackItems,
        nextPendingDecisions,
        nextManaPool,
        pumpTotals,
      ] = await Promise.all([
        getGameSession(supabase, sessionId),
        getControllerCards(supabase, sessionId, currentPlayerId),
        getBoardCards(supabase, sessionId),
        getGameSessionPlayers(supabase, sessionId),
        getTurnState(supabase, sessionId),
        getCombatActionState(supabase, sessionId),
        getCombatAssignments(supabase, sessionId),
        getStackItems(supabase, sessionId),
        getPendingDecisions(supabase, sessionId),
        getPlayerManaPool(supabase, sessionId, currentPlayerId),
        getActivePumpTotals(supabase, sessionId),
      ])

      // Fold active until-end-of-turn pumps onto each card so effective P/T shows
      // immediately, not just at declare blockers (which reads server-side P/T).
      const withPump = <T extends { id: string }>(card: T): T => {
        const pump = pumpTotals[card.id]
        return pump ? { ...card, pump_power: pump.power, pump_toughness: pump.toughness } : card
      }

      setPlayerId(currentPlayerId)
      setCards(controllerResult.cards.map(withPump))
      setBoardCards(allBoardCards.map(withPump))
      setPlayers(sessionPlayers)
      setTurnState(nextTurnState)
      setCombatActionState(nextCombatActionState)
      setCombatAssignments(nextCombatAssignments)
      setStackItems(nextStackItems)
      setPendingDecisions(nextPendingDecisions)
      setManaPool(nextManaPool)
      setIsSessionFinished(session?.status === 'finished')
      setErrorMessage(null)
      setIsLoading(false)
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to load controller v2 state:', message, error)
      setErrorMessage(message)
      setIsLoading(false)
    }
  }, [sessionId, supabase])

  useEffect(() => {
    setIsLoading(true)
    loadControllerState()

    const channel = supabase
      .channel(`controller-v2:${sessionId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_cards', filter: `session_id=eq.${sessionId}` }, loadControllerState)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cards' }, loadControllerState)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_sessions', filter: `id=eq.${sessionId}` }, loadControllerState)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_players', filter: `session_id=eq.${sessionId}` }, loadControllerState)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_session_players', filter: `session_id=eq.${sessionId}` }, loadControllerState)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_turn_state', filter: `session_id=eq.${sessionId}` }, loadControllerState)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_stack_items', filter: `session_id=eq.${sessionId}` }, loadControllerState)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_pending_decisions', filter: `session_id=eq.${sessionId}` }, loadControllerState)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_combat_assignments', filter: `session_id=eq.${sessionId}` }, loadControllerState)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_combat_blockers' }, loadControllerState)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_continuous_effects', filter: `session_id=eq.${sessionId}` }, loadControllerState)
      .subscribe((status, error) => {
        console.log('Controller v2 realtime status:', status)
        if (error) {
          console.error('Controller v2 realtime error:', error)
        }
      })

    const refreshInterval = enableFallbackRefresh
      ? window.setInterval(loadControllerState, fallbackRefreshIntervalMs)
      : null

    return () => {
      if (refreshInterval) {
        window.clearInterval(refreshInterval)
      }
      supabase.removeChannel(channel)
    }
  }, [loadControllerState, sessionId, supabase])

  return {
    supabase,
    cards,
    boardCards,
    players,
    turnState,
    combatActionState,
    combatAssignments,
    stackItems,
    pendingDecisions,
    manaPool,
    playerId,
    isSessionFinished,
    isLoading,
    errorMessage,
    setErrorMessage,
    setTurnState,
    refresh: loadControllerState,
  }
}
