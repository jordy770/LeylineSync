'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  getBoardCards,
  getCombatAssignments,
  getCommanderDamage,
  getGameSession,
  getGameSessionPlayers,
  getStackItems,
  getStatusEffects,
  getTurnState,
} from './data'
import type { CommanderDamageEntry } from './data'
import { enableFallbackRefresh, fallbackRefreshIntervalMs } from './dev'
import type {
  BoardCard,
  CombatAssignment,
  GameSession,
  GameSessionPlayer,
  GameTurnState,
  StackItem,
} from './types'

// One game action touches several tables, each firing its own realtime event.
// Coalesce that burst into a single board refresh instead of one per event.
const REFRESH_DEBOUNCE_MS = 60

export function useBoardGameState(sessionId: string) {
  const supabase = useMemo(() => createClient(), [])
  const [cards, setCards] = useState<BoardCard[]>([])
  const [session, setSession] = useState<GameSession | null>(null)
  const [players, setPlayers] = useState<GameSessionPlayer[]>([])
  const [turnState, setTurnState] = useState<GameTurnState | null>(null)
  const [combatAssignments, setCombatAssignments] = useState<CombatAssignment[]>([])
  const [stackItems, setStackItems] = useState<StackItem[]>([])
  const [attackTaxes, setAttackTaxes] = useState<{ playerId: string; mana: number; life: number }[]>([])
  const [commanderDamage, setCommanderDamage] = useState<Record<string, CommanderDamageEntry[]>>({})
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [nextSession, boardCards, sessionPlayers, nextTurnState, nextCombatAssignments, nextStackItems, status, nextCommanderDamage] =
        await Promise.all([
          getGameSession(supabase, sessionId),
          getBoardCards(supabase, sessionId),
          getGameSessionPlayers(supabase, sessionId),
          getTurnState(supabase, sessionId),
          getCombatAssignments(supabase, sessionId),
          getStackItems(supabase, sessionId),
          getStatusEffects(supabase, sessionId),
          getCommanderDamage(supabase, sessionId),
        ])

      setErrorMessage(null)
      setSession(nextSession)
      // Fold the 'animated' status (mig 277) onto each card so the board can
      // badge animated lands without a second lookup.
      setCards(boardCards.map((c) => (status.animatedIds.has(c.id) ? { ...c, animated: true } : c)))
      setPlayers(sessionPlayers)
      setTurnState(nextTurnState)
      setCombatAssignments(nextCombatAssignments)
      setStackItems(nextStackItems)
      setAttackTaxes(status.taxes)
      setCommanderDamage(nextCommanderDamage)
    } catch (error) {
      console.error('Failed to fetch board state:', error)
      setErrorMessage(error instanceof Error ? error.message : 'Could not load board state')
    }
  }, [sessionId, supabase])

  useEffect(() => {
    refresh()

    // Coalesce the burst of table-change events a single action produces into one
    // board refresh.
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    let lastRealtimeAt = 0
    const scheduleRefresh = () => {
      lastRealtimeAt = Date.now()
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => { debounceTimer = null; refresh() }, REFRESH_DEBOUNCE_MS)
    }

    const channel = supabase
      .channel(`board:${sessionId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_sessions', filter: `id=eq.${sessionId}` }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_cards', filter: `session_id=eq.${sessionId}` }, scheduleRefresh)
      // Global `cards` catalog can't be session-filtered and is static during play
      // (re-joined every refresh) — not subscribed; it fired board-wide reloads on
      // every catalog edit/import.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_turn_state', filter: `session_id=eq.${sessionId}` }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_session_players', filter: `session_id=eq.${sessionId}` }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_combat_assignments', filter: `session_id=eq.${sessionId}` }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_combat_blockers', filter: `session_id=eq.${sessionId}` }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_continuous_effects', filter: `session_id=eq.${sessionId}` }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_commander_damage', filter: `session_id=eq.${sessionId}` }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_stack_items', filter: `session_id=eq.${sessionId}` }, scheduleRefresh)
      .subscribe((status, error) => {
        console.log('Board realtime status:', status)
        if (error) {
          console.error('Board realtime error:', error)
        }
      })

    // Fallback poll: refresh only when realtime has been SILENT for an interval —
    // recovers a subscribed-but-silent channel (e.g. tables missing from the
    // supabase_realtime publication) without polling on top of live events.
    const refreshInterval = enableFallbackRefresh
      ? window.setInterval(() => {
          if (Date.now() - lastRealtimeAt >= fallbackRefreshIntervalMs) refresh()
        }, fallbackRefreshIntervalMs)
      : null

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      if (refreshInterval) {
        window.clearInterval(refreshInterval)
      }
      supabase.removeChannel(channel)
    }
  }, [refresh, sessionId, supabase])

  return {
    cards,
    session,
    players,
    turnState,
    combatAssignments,
    stackItems,
    attackTaxes,
    commanderDamage,
    errorMessage,
    refresh,
  }
}
