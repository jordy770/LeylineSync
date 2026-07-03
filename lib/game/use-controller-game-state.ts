'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getErrorMessage } from './actions'
import { getControllerState, getCurrentPlayerId, normalizeManaPool } from './data'
import { enableFallbackRefresh, fallbackRefreshIntervalMs } from './dev'
import type { CastFromTopPerm, CommanderDamageEntry, CostReductionEffect } from './data'
import type {
  BoardCard,
  CombatActionState,
  CombatAssignment,
  ControllerCard,
  GameSessionPlayer,
  GameTurnState,
  ManaPool,
  PendingDecision,
  RestrictedManaEntry,
  StackItem,
} from './types'

// One game action touches several tables, each firing its own realtime event.
// Coalesce that burst into a single state reload (~one frame) instead of running
// the full 18-query load once per event.
const RELOAD_DEBOUNCE_MS = 60

export function useControllerGameState(sessionId: string) {
  const supabase = useMemo(() => createClient(), [])
  const [cards, setCards] = useState<ControllerCard[]>([])
  const [boardCards, setBoardCards] = useState<BoardCard[]>([])
  const [players, setPlayers] = useState<GameSessionPlayer[]>([])
  const [turnState, setTurnState] = useState<GameTurnState | null>(null)
  const [attackTaxes, setAttackTaxes] = useState<{ playerId: string; mana: number; life: number }[]>([])
  const [commanderDamage, setCommanderDamage] = useState<Record<string, CommanderDamageEntry[]>>({})
  const [combatActionState, setCombatActionState] = useState<CombatActionState | null>(null)
  const [combatAssignments, setCombatAssignments] = useState<CombatAssignment[]>([])
  const [stackItems, setStackItems] = useState<StackItem[]>([])
  const [pendingDecisions, setPendingDecisions] = useState<PendingDecision[]>([])
  const [manaPool, setManaPool] = useState<ManaPool>(() => normalizeManaPool(null))
  const [restrictedMana, setRestrictedMana] = useState<RestrictedManaEntry[]>([])
  const [costReductions, setCostReductions] = useState<CostReductionEffect[]>([])
  const [playableFromExileIds, setPlayableFromExileIds] = useState<Set<string>>(() => new Set())
  const [castFromTopPerms, setCastFromTopPerms] = useState<CastFromTopPerm[]>([])
  const [playerId, setPlayerId] = useState<string | null>(null)
  const [isSessionFinished, setIsSessionFinished] = useState(false)
  const [winnerPlayerId, setWinnerPlayerId] = useState<string | null>(null)
  const [format, setFormat] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const loadControllerState = useCallback(async () => {
    try {
      const currentPlayerId = await getCurrentPlayerId(supabase)

      if (!currentPlayerId) {
        setPlayerId(null)
        setCards([])
        setManaPool(normalizeManaPool(null))
        setRestrictedMana([])
        setErrorMessage('No signed-in player found')
        setIsLoading(false)
        return
      }

      // One RPC for the whole controller view (mig 370) — replaces ~19 separate
      // PostgREST requests per reload so a long game stops accumulating network.
      const {
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
        nextRestrictedMana,
        pumpTotals,
        protectionColors,
        statusEffects,
        nextCommanderDamage,
        nextPlayableFromExileIds,
        nextCostReductions,
        nextCastFromTopPerms,
        grantedKeywords,
      } = await getControllerState(supabase, sessionId, currentPlayerId)

      // Fold active until-end-of-turn pumps onto each card so effective P/T shows
      // immediately, not just at declare blockers (which reads server-side P/T).
      const withPump = <T extends { id: string }>(card: T): T => {
        const pump = pumpTotals[card.id]
        return pump ? { ...card, pump_power: pump.power, pump_toughness: pump.toughness } : card
      }

      // Merge dynamically-granted keywords (auras/equipment/combat tricks) onto the
      // card's keyword list so the opponent view shows them — normalizeKeywords
      // dedupes against the printed line.
      const withGrantedKeywords = (card: BoardCard): BoardCard => {
        const granted = grantedKeywords[card.id]
        return granted ? { ...card, keywords: [...(card.keywords ?? []), ...granted] } : card
      }

      setPlayerId(currentPlayerId)
      setCards(controllerResult.cards.map(withPump))
      setBoardCards(
        allBoardCards.map(withPump).map(withGrantedKeywords).map((card) => ({
          ...(protectionColors[card.id] ? { ...card, protection_colors: protectionColors[card.id] } : card),
          ...(statusEffects.animatedIds.has(card.id) ? { animated: true } : {}),
        })),
      )
      setAttackTaxes(statusEffects.taxes)
      setCommanderDamage(nextCommanderDamage)
      setPlayableFromExileIds(nextPlayableFromExileIds)
      setCastFromTopPerms(nextCastFromTopPerms)
      setPlayers(sessionPlayers)
      setTurnState(nextTurnState)
      setCombatActionState(nextCombatActionState)
      setCombatAssignments(nextCombatAssignments)
      setStackItems(nextStackItems)
      setPendingDecisions(nextPendingDecisions)
      setManaPool(nextManaPool)
      setRestrictedMana(nextRestrictedMana)
      setCostReductions(nextCostReductions)
      setIsSessionFinished(session?.status === 'finished')
      setWinnerPlayerId(session?.winner_player_id ?? null)
      setFormat(session?.format ?? null)
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

    // Coalesce the burst of table-change events a single action produces into one
    // reload (a cast touches game_cards + game_stack_items + game_turn_state + …).
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    let lastRealtimeAt = 0
    // The fallback poll is keyed on whether realtime is actually DELIVERING to this
    // client, not merely on channel status. An authenticated client (a player's
    // phone) receives postgres_changes for every game table and we stop idle-polling
    // once the first one arrives — turn-based play is mostly idle, so a silence poll
    // would otherwise reload all ~18 queries every few seconds during think time. But
    // an UNAUTHENTICATED client (e.g. a board opened without login) gets a SUBSCRIBED
    // channel that delivers NOTHING — RLS yields zero postgres_changes — so it never
    // sees `hasEverReceivedEvent` flip and keeps the poll as its only update path.
    let channelHealthy = false
    let hasSubscribedOnce = false
    let hasEverReceivedEvent = false
    const scheduleReload = () => {
      lastRealtimeAt = Date.now()
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => { debounceTimer = null; loadControllerState() }, RELOAD_DEBOUNCE_MS)
    }
    // A genuine realtime delivery (vs. the re-subscribe catch-up below, which calls
    // scheduleReload directly) — proves realtime works for this client.
    const onRealtimeEvent = () => { hasEverReceivedEvent = true; scheduleReload() }

    const channel = supabase
      .channel(`controller-v2:${sessionId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_cards', filter: `session_id=eq.${sessionId}` }, onRealtimeEvent)
      // The global `cards` catalog has no session_id (can't be filtered) and is
      // static during play — its data is re-joined on every reload — so we don't
      // subscribe to it; doing so fired a game-wide reload on every catalog edit/import.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_sessions', filter: `id=eq.${sessionId}` }, onRealtimeEvent)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_players', filter: `session_id=eq.${sessionId}` }, onRealtimeEvent)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_session_players', filter: `session_id=eq.${sessionId}` }, onRealtimeEvent)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_turn_state', filter: `session_id=eq.${sessionId}` }, onRealtimeEvent)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_stack_items', filter: `session_id=eq.${sessionId}` }, onRealtimeEvent)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_pending_decisions', filter: `session_id=eq.${sessionId}` }, onRealtimeEvent)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_combat_assignments', filter: `session_id=eq.${sessionId}` }, onRealtimeEvent)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_combat_blockers', filter: `session_id=eq.${sessionId}` }, onRealtimeEvent)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_continuous_effects', filter: `session_id=eq.${sessionId}` }, onRealtimeEvent)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_commander_damage', filter: `session_id=eq.${sessionId}` }, onRealtimeEvent)
      .subscribe((status, error) => {
        console.log('Controller v2 realtime status:', status)
        if (status === 'SUBSCRIBED') {
          // A RE-subscribe (after a dropped connection) may have missed events while
          // down — reload once to catch up. The first subscribe is covered by the
          // initial loadControllerState() above, so skip it.
          if (hasSubscribedOnce) scheduleReload()
          hasSubscribedOnce = true
          channelHealthy = true
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          channelHealthy = false
        }
        if (error) {
          console.error('Controller v2 realtime error:', error)
        }
      })

    // Fallback poll: only for clients realtime can't serve — a DOWN channel, or a
    // SUBSCRIBED-but-silent one that has never delivered an event (an unauthenticated
    // board: RLS yields zero postgres_changes). Once we've received any event we know
    // realtime works and stop idle-polling, so authenticated players (whose realtime
    // delivers) no longer reload ~18 queries every few seconds during think time.
    const refreshInterval = enableFallbackRefresh
      ? window.setInterval(() => {
          if ((!channelHealthy || !hasEverReceivedEvent) && Date.now() - lastRealtimeAt >= fallbackRefreshIntervalMs) {
            loadControllerState()
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
  }, [loadControllerState, sessionId, supabase])

  return {
    supabase,
    cards,
    boardCards,
    players,
    turnState,
    attackTaxes,
    commanderDamage,
    combatActionState,
    combatAssignments,
    stackItems,
    pendingDecisions,
    manaPool,
    restrictedMana,
    costReductions,
    playableFromExileIds,
    castFromTopPerms,
    playerId,
    isSessionFinished,
    winnerPlayerId,
    format,
    isLoading,
    errorMessage,
    setErrorMessage,
    setTurnState,
    refresh: loadControllerState,
  }
}
