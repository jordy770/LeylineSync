'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getBoardState } from './data'
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
      // One RPC for the whole board view (mig 371) — replaces ~8 separate reads.
      const { nextSession, boardCards, sessionPlayers, nextTurnState, nextCombatAssignments, nextStackItems, status, nextCommanderDamage } =
        await getBoardState(supabase, sessionId)

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
    // The fallback poll is keyed on whether realtime is actually DELIVERING to this
    // client. An authenticated client receives postgres_changes for every game table
    // and we stop idle-polling once the first arrives. But an UNAUTHENTICATED board
    // (opened without login) gets a SUBSCRIBED channel that delivers NOTHING — RLS
    // yields zero postgres_changes — so `hasEverReceivedEvent` never flips and the
    // poll stays on as its only update path (e.g. so a bot's move still appears).
    let channelHealthy = false
    let hasSubscribedOnce = false
    let hasEverReceivedEvent = false
    const scheduleRefresh = () => {
      lastRealtimeAt = Date.now()
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => { debounceTimer = null; refresh() }, REFRESH_DEBOUNCE_MS)
    }
    // A genuine realtime delivery (vs. the re-subscribe catch-up, which calls
    // scheduleRefresh directly) — proves realtime works for this client.
    const onRealtimeEvent = () => { hasEverReceivedEvent = true; scheduleRefresh() }

    const channel = supabase
      .channel(`board:${sessionId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_sessions', filter: `id=eq.${sessionId}` }, onRealtimeEvent)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_cards', filter: `session_id=eq.${sessionId}` }, onRealtimeEvent)
      // Global `cards` catalog can't be session-filtered and is static during play
      // (re-joined every refresh) — not subscribed; it fired board-wide reloads on
      // every catalog edit/import.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_turn_state', filter: `session_id=eq.${sessionId}` }, onRealtimeEvent)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_session_players', filter: `session_id=eq.${sessionId}` }, onRealtimeEvent)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_combat_assignments', filter: `session_id=eq.${sessionId}` }, onRealtimeEvent)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_combat_blockers', filter: `session_id=eq.${sessionId}` }, onRealtimeEvent)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_continuous_effects', filter: `session_id=eq.${sessionId}` }, onRealtimeEvent)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_commander_damage', filter: `session_id=eq.${sessionId}` }, onRealtimeEvent)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_stack_items', filter: `session_id=eq.${sessionId}` }, onRealtimeEvent)
      .subscribe((status, error) => {
        console.log('Board realtime status:', status)
        if (status === 'SUBSCRIBED') {
          // A RE-subscribe (after a dropped connection) may have missed events while
          // down — refresh once to catch up. The first subscribe is covered by the
          // initial refresh() above, so skip it.
          if (hasSubscribedOnce) scheduleRefresh()
          hasSubscribedOnce = true
          channelHealthy = true
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          channelHealthy = false
        }
        if (error) {
          console.error('Board realtime error:', error)
        }
      })

    // Fallback poll: only for clients realtime can't serve — a DOWN channel, or a
    // SUBSCRIBED-but-silent one that has never delivered an event (an unauthenticated
    // board: RLS yields zero postgres_changes). Once we've received any event we trust
    // realtime and stop idle-polling. An anon board keeps polling so a bot/opponent
    // move still appears.
    const refreshInterval = enableFallbackRefresh
      ? window.setInterval(() => {
          if ((!channelHealthy || !hasEverReceivedEvent) && Date.now() - lastRealtimeAt >= fallbackRefreshIntervalMs) {
            refresh()
          }
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
