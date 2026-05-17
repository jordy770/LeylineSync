'use client'

import { ArrowDown, ArrowUp, Swords } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { getErrorMessage, resolveCombatDamage, setCombatBlockerOrder } from '@/lib/game/actions'
import { getCombatActionState, getCombatAssignments, getGameSession } from '@/lib/game/data'
import { enableFallbackRefresh, fallbackRefreshIntervalMs } from '@/lib/game/dev'
import { createClient } from '@/lib/supabase/client'
import type { CombatActionState, CombatAssignment } from '@/lib/game/types'

export default function CombatAssignmentsPanel({ sessionId }: { sessionId: string }) {
  const supabase = useMemo(() => createClient(), [])
  const [assignments, setAssignments] = useState<CombatAssignment[]>([])
  const [combatActionState, setCombatActionState] = useState<CombatActionState | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [isResolvingDamage, setIsResolvingDamage] = useState(false)
  const [orderingAssignmentId, setOrderingAssignmentId] = useState<string | null>(null)
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
          table: 'game_combat_blockers',
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

    const refreshInterval = enableFallbackRefresh ? window.setInterval(loadAssignments, fallbackRefreshIntervalMs) : null

    return () => {
      isMounted = false
      if (refreshInterval) {
        window.clearInterval(refreshInterval)
      }
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
        `${formatDamageStage(result.damage_stage)}: ${result.assignments_resolved} assignment(s) resolved, ${result.total_player_damage ?? result.total_damage} player damage, ${result.total_creature_damage ?? 0} creature damage, ${result.creatures_destroyed ?? 0} destroyed`,
      )
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to resolve combat damage:', message, error)
      setErrorMessage(message)
    } finally {
      setIsResolvingDamage(false)
    }
  }

  const handleMoveBlocker = async (
    assignment: CombatAssignment,
    blockerCardId: string,
    direction: -1 | 1,
  ) => {
    const blockers = assignment.blockers ?? []
    const currentIndex = blockers.findIndex((blocker) => blocker.blocker_card_id === blockerCardId)
    const nextIndex = currentIndex + direction

    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= blockers.length) {
      return
    }

    const nextOrder = [...blockers]
    const [movedBlocker] = nextOrder.splice(currentIndex, 1)
    nextOrder.splice(nextIndex, 0, movedBlocker)

    setErrorMessage(null)
    setStatusMessage(null)
    setOrderingAssignmentId(assignment.id)

    try {
      await setCombatBlockerOrder(
        supabase,
        sessionId,
        assignment.id,
        nextOrder.map((blocker) => blocker.blocker_card_id),
      )
      const nextAssignments = await getCombatAssignments(supabase, sessionId)
      setAssignments(nextAssignments)
      setStatusMessage(`Damage order updated for ${assignment.attacker_name}.`)
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to set combat damage order:', message, error)
      setErrorMessage(message)
    } finally {
      setOrderingAssignmentId(null)
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
                <div className="mt-2">
                  <p className="text-xs text-slate-400">
                    Blocked by {assignment.blocker_name ?? 'Unknown'}
                  </p>
                  <BlockerOrderControls
                    assignment={assignment}
                    canOrder={canOrderBlockers(assignment, combatActionState, isSessionFinished)}
                    isOrdering={orderingAssignmentId === assignment.id}
                    onMoveBlocker={handleMoveBlocker}
                  />
                </div>
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

function BlockerOrderControls({
  assignment,
  canOrder,
  isOrdering,
  onMoveBlocker,
}: {
  assignment: CombatAssignment
  canOrder: boolean
  isOrdering: boolean
  onMoveBlocker: (assignment: CombatAssignment, blockerCardId: string, direction: -1 | 1) => void
}) {
  const blockers = assignment.blockers ?? []

  if (blockers.length <= 1) {
    return null
  }

  return (
    <div className="mt-2 rounded-md border border-slate-800 bg-slate-950/70 p-2">
      <p className="mb-2 text-xs font-medium text-slate-300">Damage order</p>
      <div className="space-y-1">
        {blockers.map((blocker, index) => (
          <div
            key={blocker.id}
            className="flex items-center justify-between gap-2 rounded bg-slate-900 px-2 py-1"
          >
            <span className="min-w-0 truncate text-xs text-slate-300">
              {index + 1}. {blocker.blocker_name}
            </span>
            {canOrder ? (
              <div className="flex shrink-0 gap-1">
                <button
                  type="button"
                  onClick={() => onMoveBlocker(assignment, blocker.blocker_card_id, -1)}
                  disabled={isOrdering || index === 0}
                  className="rounded border border-slate-700 p-1 text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label={`Move ${blocker.blocker_name} up`}
                  title="Move up"
                >
                  <ArrowUp className="h-3 w-3" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => onMoveBlocker(assignment, blocker.blocker_card_id, 1)}
                  disabled={isOrdering || index === blockers.length - 1}
                  className="rounded border border-slate-700 p-1 text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label={`Move ${blocker.blocker_name} down`}
                  title="Move down"
                >
                  <ArrowDown className="h-3 w-3" aria-hidden="true" />
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {!canOrder ? (
        <p className="mt-2 text-xs text-slate-500">Attacking player sets this while they have priority.</p>
      ) : null}
    </div>
  )
}

function canOrderBlockers(
  assignment: CombatAssignment,
  combatActionState: CombatActionState | null,
  isSessionFinished: boolean,
) {
  if (isSessionFinished || !combatActionState || (assignment.blockers ?? []).length <= 1) {
    return false
  }

  const step = combatActionState.step
  const currentPlayerId = combatActionState.current_player_id
  const priorityPlayerId = combatActionState.priority_player_id ?? combatActionState.active_player_id

  return (
    assignment.attacking_player_id === currentPlayerId &&
    currentPlayerId === priorityPlayerId &&
    (step === 'declare_blockers' || step === 'combat_damage')
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

function formatDamageStage(stage: string | undefined) {
  if (stage === 'first_strike') {
    return 'First strike damage'
  }

  return 'Combat damage'
}
