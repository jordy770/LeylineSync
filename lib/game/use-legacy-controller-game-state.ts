'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getErrorMessage } from './actions'
import {
  getBoardCards,
  getCombatActionState,
  getCombatAssignments,
  getControllerCards,
  getCurrentPlayerId,
  getGameSession,
  getGameSessionPlayers,
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
  StackItem,
} from './types'

export function useLegacyControllerGameState(sessionId: string) {
  const supabase = useMemo(() => createClient(), [])
  const [cards, setCards] = useState<ControllerCard[]>([])
  const [allBoardCards, setAllBoardCards] = useState<BoardCard[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [lastFetchInfo, setLastFetchInfo] = useState<string | null>(null)
  const [playerId, setPlayerId] = useState<string | null>(null)
  const [combatActionState, setCombatActionState] = useState<CombatActionState | null>(null)
  const [combatAssignments, setCombatAssignments] = useState<CombatAssignment[]>([])
  const [isSessionFinished, setIsSessionFinished] = useState(false)
  const [sessionPlayers, setSessionPlayers] = useState<GameSessionPlayer[]>([])
  const [turnState, setTurnState] = useState<GameTurnState | null>(null)
  const [stackItems, setStackItems] = useState<StackItem[]>([])
  const [manaPool, setManaPool] = useState<ManaPool>(() => normalizeManaPool(null))
  const [pendingStackCount, setPendingStackCount] = useState(0)
  const playerIdRef = useRef<string | null>(null)

  const fetchPlayer = useCallback(async () => {
    const resolvedPlayerId = await getCurrentPlayerId(supabase)
    playerIdRef.current = resolvedPlayerId
    setPlayerId(resolvedPlayerId)
    return resolvedPlayerId
  }, [supabase])

  const fetchCards = useCallback(
    async (currentPlayerId: string) => {
      setErrorMessage(null)

      try {
        const [result, nextManaPool] = await Promise.all([
          getControllerCards(supabase, sessionId, currentPlayerId),
          getPlayerManaPool(supabase, sessionId, currentPlayerId),
        ])

        setCards(result.cards)
        setManaPool(nextManaPool)
        setLastFetchInfo(
          result.missingCardIds.length > 0
            ? `Session ${sessionId}: ${result.rowCount} card(s) loaded, ${result.missingCardIds.length} card id(s) not found in cards`
            : `Session ${sessionId}: ${result.rowCount} card(s) loaded`,
        )

        console.log('Controller cards loaded:', {
          sessionId,
          count: result.rowCount,
          cards: result.cards,
          missingCardIds: result.missingCardIds,
        })
      } catch (error) {
        console.error('Failed to fetch controller cards:', error)
        setErrorMessage(error instanceof Error ? error.message : 'Could not load controller cards')
        setCards([])
      } finally {
        setIsLoading(false)
      }
    },
    [sessionId, supabase],
  )

  const loadControllerCards = useCallback(async () => {
    try {
      const currentPlayerId = playerIdRef.current ?? (await fetchPlayer())

      if (!currentPlayerId) {
        setCards([])
        setLastFetchInfo(`Session ${sessionId}: no signed-in player found`)
        setIsLoading(false)
        return
      }

      await fetchCards(currentPlayerId)
    } catch (error) {
      console.error('Failed to initialize controller cards:', error)
      setErrorMessage(error instanceof Error ? error.message : 'Could not load controller cards')
      setCards([])
      setIsLoading(false)
    }
  }, [fetchCards, fetchPlayer, sessionId])

  const loadGameContext = useCallback(async () => {
    try {
      const [
        session,
        nextCombatActionState,
        nextCombatAssignments,
        nextSessionPlayers,
        nextStackItems,
        nextTurnState,
        nextBoardCards,
      ] = await Promise.all([
        getGameSession(supabase, sessionId),
        getCombatActionState(supabase, sessionId),
        getCombatAssignments(supabase, sessionId),
        getGameSessionPlayers(supabase, sessionId),
        getStackItems(supabase, sessionId),
        getTurnState(supabase, sessionId),
        getBoardCards(supabase, sessionId),
      ])

      setIsSessionFinished(session?.status === 'finished')
      setCombatActionState(nextCombatActionState)
      setCombatAssignments(nextCombatAssignments)
      setSessionPlayers(nextSessionPlayers)
      setStackItems(nextStackItems)
      setPendingStackCount(nextStackItems.filter((item) => item.status === 'pending').length)
      setTurnState(nextTurnState)
      setAllBoardCards(nextBoardCards)
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to load controller game context:', message, error)
      setErrorMessage(message)
    }
  }, [sessionId, supabase])

  const refreshCardsForCurrentPlayer = useCallback(() => {
    if (playerIdRef.current) {
      fetchCards(playerIdRef.current)
    }
  }, [fetchCards])

  useEffect(() => {
    setIsLoading(true)
    playerIdRef.current = null
    loadControllerCards()
    loadGameContext()

    const channel = supabase
      .channel(`controller:${sessionId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_cards', filter: `session_id=eq.${sessionId}` }, refreshCardsForCurrentPlayer)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cards' }, refreshCardsForCurrentPlayer)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_sessions', filter: `id=eq.${sessionId}` }, loadGameContext)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_stack_items', filter: `session_id=eq.${sessionId}` }, loadGameContext)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_turn_state', filter: `session_id=eq.${sessionId}` }, loadGameContext)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_combat_assignments', filter: `session_id=eq.${sessionId}` }, loadGameContext)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_combat_blockers' }, loadGameContext)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'game_players', filter: `session_id=eq.${sessionId}` },
        () => {
          refreshCardsForCurrentPlayer()
          loadGameContext()
        },
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_session_players', filter: `session_id=eq.${sessionId}` }, loadGameContext)
      .subscribe((status, error) => {
        console.log('Controller realtime status:', status)
        if (error) {
          console.error('Controller realtime error:', error)
        }
      })

    const refreshInterval = enableFallbackRefresh
      ? window.setInterval(() => {
          refreshCardsForCurrentPlayer()
          loadGameContext()
        }, fallbackRefreshIntervalMs)
      : null

    return () => {
      if (refreshInterval) {
        window.clearInterval(refreshInterval)
      }
      supabase.removeChannel(channel)
    }
  }, [loadControllerCards, loadGameContext, refreshCardsForCurrentPlayer, sessionId, supabase])

  return {
    supabase,
    cards,
    allBoardCards,
    isLoading,
    errorMessage,
    lastFetchInfo,
    playerId,
    combatActionState,
    combatAssignments,
    isSessionFinished,
    sessionPlayers,
    turnState,
    stackItems,
    manaPool,
    pendingStackCount,
    setCards,
    setErrorMessage,
    setTurnState,
  }
}
