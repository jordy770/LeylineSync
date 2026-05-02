'use client'

import { Swords } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { getErrorMessage, resolveCombatDamage } from '@/lib/game/actions'
import { getCombatActionState, getCombatAssignments, getGameSession } from '@/lib/game/data'
import { createClient } from '@/lib/supabase/client'
import type { CombatActionState, CombatAssignment } from '@/lib/game/types'

export default function CombatAssignmentsPanel({ sessionId }: { sessionId: string }) {
  const supabase = useMemo(() => createClient(), [])
  const [assignments, setAssignments] = useState<CombatAssignment[]>([])
  const [combatActionState, setCombatActionState] = useState<CombatActionState | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [isResolvingDamage, setIsResolvingDamage] = useState(false)
  const [isSessionFinished, setIsSessionFinished] = useState(false)

  useEffect(() => {
    let isMounted = true

    const loadAssignments = async () => {
      try {
        const [session, combatAssignments, nextCombatActionState] = await Promise.all([
          getGameSession(supabase, sessionId),
          getCombatAssignments(supabase, sessionId),
          getCombatActionState(supabase, sessionId),
        ])

        if (isMounted) {
          setIsSessionFinished(session?.status === 'finished')
          setAssignments(combatAssignments)
          setCombatActionState(nextCombatActionState)
          setErrorMessage(null)
        }
      } catch (error) {
        const message = getErrorMessage(error)
        console.error('Failed to load combat assignments:', message, error)
        if (isMounted) {
          setErrorMessage(message)
        }
      }
    }

    loadAssignments()

    const channel = supabase
      .channel(`combat-assignments:${sessionId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_sessions',
          filter: `id=eq.${sessionId}`,
        },
        loadAssignments,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_combat_assignments',
          filter: `session_id=eq.${sessionId}`,
        },
        loadAssignments,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_session_players',
          filter: `session_id=eq.${sessionId}`,
        },
        loadAssignments,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_turn_state',
          filter: `session_id=eq.${sessionId}`,
        },
        loadAssignments,
      )
      .subscribe((status, error) => {
        console.log('Combat assignments realtime status:', status)
        if (error) {
          console.error('Combat assignments realtime error:', error)
        }
      })

    const refreshInterval = window.setInterval(loadAssignments, 2000)

    return () => {
      isMounted = false
      window.clearInterval(refreshInterval)
      supabase.removeChannel(channel)
    }
  }, [sessionId, supabase])

  const handleResolveCombatDamage = async () => {
    setErrorMessage(null)
    setStatusMessage(null)
    setIsResolvingDamage(true)

    try {
      const result = await resolveCombatDamage(supabase, sessionId)
      const [session, combatAssignments, nextCombatActionState] = await Promise.all([
        getGameSession(supabase, sessionId),
        getCombatAssignments(supabase, sessionId),
        getCombatActionState(supabase, sessionId),
      ])
      setIsSessionFinished(session?.status === 'finished')
      setAssignments(combatAssignments)
      setCombatActionState(nextCombatActionState)
      setStatusMessage(
        `${result.assignments_resolved} assignment(s) resolved, ${result.total_player_damage ?? result.total_damage} player damage, ${result.total_creature_damage ?? 0} creature damage, ${result.creatures_destroyed ?? 0} destroyed`,
      )
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to resolve combat damage:', message, error)
      setErrorMessage(message)
    } finally {
      setIsResolvingDamage(false)
    }
  }

  const canResolveCombatDamage =
    Boolean(combatActionState?.can_resolve_combat_damage) && !isSessionFinished
  const damageDisabledReason = getDamageDisabledReason(combatActionState, isSessionFinished)

  return (
    <section className="mb-5 rounded-lg border border-slate-800 bg-slate-950 p-4">
      <div className="mb-3 flex items-center gap-2">
        <Swords className="h-4 w-4 text-amber-300" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-white">Combat</h2>
      </div>

      {assignments.length === 0 ? (
        <p className="text-sm text-slate-500">No attackers declared.</p>
      ) : (
        <div className="grid gap-2 md:grid-cols-2">
          {assignments.map((assignment) => (
            <div key={assignment.id} className="rounded-md bg-slate-900 p-3">
              <p className="truncate text-sm font-semibold text-white">
                {assignment.attacker_name}
              </p>
              <p className="text-xs text-slate-500">
                {assignment.attacking_username} attacks {assignment.defending_username}
              </p>
              {assignment.blocker_card_id ? (
                <p className="mt-2 text-xs text-slate-400">
                  Blocked by {assignment.blocker_name ?? 'Unknown'}
                </p>
              ) : (
                <p className="mt-2 text-xs text-amber-300">Unblocked</p>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <button
          type="button"
          onClick={handleResolveCombatDamage}
          disabled={!canResolveCombatDamage || isResolvingDamage}
          className="rounded-md bg-red-400 px-3 py-2 text-sm font-semibold text-red-950 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isResolvingDamage ? 'Resolving...' : 'Resolve Combat Damage'}
        </button>
        {!canResolveCombatDamage && damageDisabledReason ? (
          <p className="text-xs text-slate-500">{damageDisabledReason}</p>
        ) : null}
      </div>

      {statusMessage ? <p className="mt-3 text-xs text-emerald-300">{statusMessage}</p> : null}
      {errorMessage ? <p className="mt-3 text-xs text-red-300">{errorMessage}</p> : null}
    </section>
  )
}

function getDamageDisabledReason(
  combatActionState: CombatActionState | null,
  isSessionFinished: boolean,
) {
  if (isSessionFinished) {
    return 'Game is finished.'
  }

  if (!combatActionState) {
    return 'Checking combat damage state...'
  }

  if (!combatActionState.can_resolve_combat_damage) {
    return combatActionState.damage_reason ?? 'Combat damage is not available right now.'
  }

  return null
}
