'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { advanceStep, getErrorMessage, initializeTurnState, passPriority } from '@/lib/game/actions'
import { getCurrentPlayerId, getGameSession, getTurnState, normalizeTurnState } from '@/lib/game/data'
import { enableFallbackRefresh } from '@/lib/game/dev'
import type { GameTurnState } from '@/lib/game/types'
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'

const phaseLabels: Record<GameTurnState['phase'], string> = {
  beginning: 'Beginning',
  main_1: 'Main Phase 1',
  combat: 'Combat',
  main_2: 'Main Phase 2',
  ending: 'Ending',
}

const stepLabels: Record<GameTurnState['step'], string> = {
  untap: 'Untap Step',
  upkeep: 'Upkeep Step',
  draw: 'Draw Step',
  precombat_main: 'Precombat Main',
  beginning_of_combat: 'Beginning of Combat',
  declare_attackers: 'Declare Attackers',
  declare_blockers: 'Declare Blockers',
  combat_damage: 'Combat Damage',
  end_of_combat: 'End of Combat',
  postcombat_main: 'Postcombat Main',
  end: 'End Step',
  cleanup: 'Cleanup Step',
}

export default function TurnStatusPanel({ sessionId }: { sessionId: string }) {
  const supabase = useMemo(() => createClient(), [])
  const [turnState, setTurnState] = useState<GameTurnState | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [currentPlayerId, setCurrentPlayerId] = useState<string | null>(null)
  const [isAdvancing, setIsAdvancing] = useState(false)
  const [isPassingPriority, setIsPassingPriority] = useState(false)
  const [isSessionFinished, setIsSessionFinished] = useState(false)

  useEffect(() => {
    let isMounted = true

    const loadTurnState = async () => {
      try {
        const playerId = await getCurrentPlayerId(supabase)

        if (isMounted) {
          setCurrentPlayerId(playerId)
        }

        const [session, existingState] = await Promise.all([
          getGameSession(supabase, sessionId),
          getTurnState(supabase, sessionId),
        ])

        if (isMounted) {
          setIsSessionFinished(session?.status === 'finished')
        }

        if (existingState) {
          if (isMounted) {
            setTurnState(existingState)
            setErrorMessage(null)
            setIsLoading(false)
          }
          return
        }

        if (!playerId) {
          if (isMounted) {
            setTurnState(null)
            setErrorMessage('Turn state is not initialized')
            setIsLoading(false)
          }
          return
        }

        if (session?.status === 'finished') {
          if (isMounted) {
            setTurnState(null)
            setErrorMessage('Game is finished')
            setIsLoading(false)
          }
          return
        }

        const initializedState = await initializeTurnState(supabase, sessionId, playerId)

        if (isMounted) {
          setTurnState(normalizeTurnState(initializedState))
          setErrorMessage(null)
          setIsLoading(false)
        }
      } catch (error) {
        const message = getErrorMessage(error)
        console.error('Failed to load turn state:', message, error)
        if (isMounted) {
          setErrorMessage(message)
          setIsLoading(false)
        }
      }
    }

    loadTurnState()

    const channel = supabase
      .channel(`turn-state:${sessionId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_sessions',
          filter: `id=eq.${sessionId}`,
        },
        loadTurnState,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_turn_state',
          filter: `session_id=eq.${sessionId}`,
        },
        (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
          if (payload.new) {
            setTurnState(normalizeTurnState(payload.new as Partial<GameTurnState>))
            setErrorMessage(null)
          }
        },
      )
      .subscribe((status, error) => {
        console.log('Turn state realtime status:', status)
        if (error) {
          console.error('Turn state realtime error:', error)
        }
      })

    const refreshInterval = enableFallbackRefresh ? window.setInterval(loadTurnState, 2000) : null

    return () => {
      isMounted = false
      if (refreshInterval) {
        window.clearInterval(refreshInterval)
      }
      supabase.removeChannel(channel)
    }
  }, [sessionId, supabase])

  const handleAdvanceStep = async () => {
    setErrorMessage(null)
    setIsAdvancing(true)

    try {
      const nextTurnState = await advanceStep(supabase, sessionId)
      setTurnState(normalizeTurnState(nextTurnState))
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to advance step:', message, error)
      setErrorMessage(message)
    } finally {
      setIsAdvancing(false)
    }
  }

  const handlePassPriority = async () => {
    setErrorMessage(null)
    setIsPassingPriority(true)

    try {
      const nextTurnState = await passPriority(supabase, sessionId)
      setTurnState(normalizeTurnState(nextTurnState))
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to pass priority:', message, error)
      setErrorMessage(message)
    } finally {
      setIsPassingPriority(false)
    }
  }

  const canAdvance = Boolean(
    !isSessionFinished &&
      turnState?.priority_player_id &&
      currentPlayerId &&
      turnState.priority_player_id === currentPlayerId,
  )
  const canPassPriority = canAdvance

  return (
    <section className="mb-5 rounded-lg border border-slate-800 bg-slate-950 p-4">
      <div className="grid gap-3 sm:grid-cols-8">
        <div>
          <p className="text-xs text-slate-500">Turn</p>
          <p className="text-lg font-semibold text-white">{turnState?.turn_number ?? '-'}</p>
        </div>
        <div>
          <p className="text-xs text-slate-500">Phase</p>
          <p className="text-sm font-semibold text-white">
            {turnState ? phaseLabels[turnState.phase] : '-'}
          </p>
        </div>
        <div>
          <p className="text-xs text-slate-500">Step</p>
          <p className="text-sm font-semibold text-white">
            {turnState ? stepLabels[turnState.step] : '-'}
          </p>
        </div>
        <div>
          <p className="text-xs text-slate-500">Active Player</p>
          <p className="truncate font-mono text-sm text-white">
            {turnState?.active_player_id ? turnState.active_player_id.slice(0, 8) : '-'}
            {turnState?.active_username ? ` (${turnState.active_username})` : ''}
          </p>
        </div>
        <div>
          <p className="text-xs text-slate-500">Priority</p>
          <p className="truncate font-mono text-sm text-white">
            {turnState?.priority_player_id ? turnState.priority_player_id.slice(0, 8) : '-'}
            {turnState?.priority_username ? ` (${turnState.priority_username})` : ''}
          </p>
        </div>
        <div>
          <p className="text-xs text-slate-500">Passes</p>
          <p className="text-sm font-semibold text-white">{turnState?.priority_pass_count ?? 0}</p>
        </div>
        <div>
          <p className="text-xs text-slate-500">Land Plays</p>
          <p className="text-sm font-semibold text-white">
            {turnState
              ? `${Math.min(turnState.lands_played_this_turn ?? 0, turnState.land_play_limit ?? 1)}/${turnState.land_play_limit ?? 1}`
              : '-'}
          </p>
        </div>
        <div className="flex items-end">
          <button
            type="button"
            onClick={handleAdvanceStep}
            disabled={!canAdvance || isAdvancing}
            className="w-full rounded-md bg-white px-4 py-2 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isAdvancing ? 'Advancing...' : 'Next Step'}
          </button>
        </div>
        <div className="flex items-end">
          <button
            type="button"
            onClick={handlePassPriority}
            disabled={!canPassPriority || isPassingPriority}
            className="w-full rounded-md bg-amber-300 px-4 py-2 text-sm font-semibold text-amber-950 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPassingPriority ? 'Passing...' : 'Pass Priority'}
          </button>
        </div>
      </div>
      {isLoading ? <p className="mt-3 text-xs text-slate-500">Loading turn state...</p> : null}
      {isSessionFinished ? (
        <p className="mt-3 text-xs text-slate-500">Game is finished. Turn actions are locked.</p>
      ) : null}
      {errorMessage ? <p className="mt-3 text-xs text-red-300">{errorMessage}</p> : null}
    </section>
  )
}
