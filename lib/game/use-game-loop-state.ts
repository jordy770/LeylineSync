'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { enableFallbackRefresh, fallbackRefreshIntervalMs } from './dev'
import {
  createGameLoopActions,
  createGameLoopState,
  gameStateTables,
  type GameCardSnapshot,
  type GameLoopActions,
  type GameLoopState,
} from './blueprint'
import {
  getCombatAssignments,
  getCurrentPlayerId,
  getGameSession,
  getGameSessionPlayers,
  getStackItems,
  getTurnState,
  normalizeGameZone,
  normalizeManaPool,
} from './data'
import type { ManaPool } from './types'

type GamePlayerManaRow = {
  player_id: string
  mana_pool: ManaPool | null
}

const emptyGameLoopState: GameLoopState = {
  session: null,
  turn: null,
  currentPlayerId: null,
  players: [],
  zonesByPlayer: {},
  stack: [],
  combat: [],
  manaPools: {},
}

export type UseGameLoopStateResult = {
  state: GameLoopState
  actions: GameLoopActions
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useGameLoopState(sessionId: string): UseGameLoopStateResult {
  const supabase = useMemo(() => createClient(), [])
  const [state, setState] = useState<GameLoopState>(emptyGameLoopState)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const stateRef = useRef<GameLoopState>(emptyGameLoopState)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  const refresh = useCallback(async () => {
    try {
      const nextState = await fetchGameLoopState(supabase, sessionId)
      setState(nextState)
      setError(null)
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Could not load game loop state')
    } finally {
      setIsLoading(false)
    }
  }, [sessionId, supabase])

  useEffect(() => {
    setIsLoading(true)
    refresh()

    const channel = supabase.channel(`game-loop:${sessionId}`)

    for (const table of gameStateTables) {
      channel.on(
        'postgres_changes',
        getRealtimeConfig(table, sessionId),
        refresh,
      )
    }

    channel.subscribe((status, subscribeError) => {
      if (subscribeError) {
        console.error('Game loop realtime error:', status, subscribeError)
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

  const actions = useMemo(
    () =>
      createGameLoopActions({
        supabase,
        sessionId,
        getState: () => stateRef.current,
      }),
    [sessionId, supabase],
  )

  return {
    state,
    actions,
    isLoading,
    error,
    refresh,
  }
}

export async function fetchGameLoopState(
  supabase: ReturnType<typeof createClient>,
  sessionId: string,
): Promise<GameLoopState> {
  const [
    currentPlayerId,
    session,
    turn,
    players,
    cards,
    stack,
    combat,
    manaPools,
  ] = await Promise.all([
    getCurrentPlayerId(supabase),
    getGameSession(supabase, sessionId),
    getTurnState(supabase, sessionId),
    getGameSessionPlayers(supabase, sessionId),
    getGameCardsSnapshot(supabase, sessionId),
    getStackItems(supabase, sessionId),
    getCombatAssignments(supabase, sessionId),
    getManaPoolsByPlayer(supabase, sessionId),
  ])

  return createGameLoopState({
    session,
    turn,
    currentPlayerId,
    players,
    cards,
    stack,
    combat,
    manaPools,
  })
}

async function getGameCardsSnapshot(
  supabase: ReturnType<typeof createClient>,
  sessionId: string,
): Promise<GameCardSnapshot[]> {
  const { data, error } = await supabase
    .from('game_cards')
    .select('id, card_id, owner_id, controller_player_id, zone, zone_position, is_tapped, damage_marked')
    .eq('session_id', sessionId)

  if (error) {
    throw error
  }

  return (data ?? []).map((card) => ({
    id: card.id,
    card_id: card.card_id,
    owner_id: card.owner_id,
    controller_player_id: card.controller_player_id ?? null,
    zone: normalizeGameZone(card.zone),
    zone_position: card.zone_position ?? 0,
    is_tapped: card.is_tapped,
    damage_marked: card.damage_marked ?? 0,
  }))
}

async function getManaPoolsByPlayer(
  supabase: ReturnType<typeof createClient>,
  sessionId: string,
) {
  const { data, error } = await supabase
    .from('game_players')
    .select('player_id, mana_pool')
    .eq('session_id', sessionId)

  if (error) {
    throw error
  }

  return ((data ?? []) as GamePlayerManaRow[]).reduce<Record<string, ManaPool>>((manaPools, row) => {
    manaPools[row.player_id] = normalizeManaPool(row.mana_pool)
    return manaPools
  }, {})
}

function getRealtimeConfig(table: string, sessionId: string) {
  const baseConfig = {
    event: '*' as const,
    schema: 'public',
    table,
  }

  if (table === 'cards' || table === 'game_combat_blockers') {
    return baseConfig
  }

  if (table === 'game_sessions') {
    return {
      ...baseConfig,
      filter: `id=eq.${sessionId}`,
    }
  }

  return {
    ...baseConfig,
    filter: `session_id=eq.${sessionId}`,
  }
}
