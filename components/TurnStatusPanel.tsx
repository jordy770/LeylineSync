'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { advanceStep, getErrorMessage, initializeTurnState } from '@/lib/game/actions'
import { getCurrentPlayerId, getTurnState, normalizeTurnState } from '@/lib/game/data'
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

  useEffect(() => {
    let isMounted = true

    const loadTurnState = async () => {
      try {
        const playerId = await getCurrentPlayerId(supabase)

        if (isMounted) {
          setCurrentPlayerId(playerId)
        }

        const existingState = await getTurnState(supabase, sessionId)

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

        const initializedState = await initializeTurnState(supabase, sessionId, playerId)

        if (isMounted) {
          setTurnState(normalizeTurnState(initializedState))
          setErrorMessage(null)
          setIsLoading(false)
        }
      } catch (error) {
        console.error('Failed to load turn state:', error)
        if (isMounted) {
          setErrorMessage(error instanceof Error ? error.message : 'Could not load turn state')
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

    return () => {
      isMounted = false
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

  const canAdvance = Boolean(
    turnState?.active_player_id && currentPlayerId && turnState.active_player_id === currentPlayerId,
  )

  return (
    <section className="mb-5 rounded-lg border border-slate-800 bg-slate-950 p-4">
      <div className="grid gap-3 sm:grid-cols-5">
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
      </div>
      {isLoading ? <p className="mt-3 text-xs text-slate-500">Loading turn state...</p> : null}
      {errorMessage ? <p className="mt-3 text-xs text-red-300">{errorMessage}</p> : null}
    </section>
  )
}
