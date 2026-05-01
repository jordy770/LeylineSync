'use client'

import { Swords } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { getErrorMessage } from '@/lib/game/actions'
import { getCombatAssignments } from '@/lib/game/data'
import { createClient } from '@/lib/supabase/client'
import type { CombatAssignment } from '@/lib/game/types'

export default function CombatAssignmentsPanel({ sessionId }: { sessionId: string }) {
  const supabase = useMemo(() => createClient(), [])
  const [assignments, setAssignments] = useState<CombatAssignment[]>([])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true

    const loadAssignments = async () => {
      try {
        const combatAssignments = await getCombatAssignments(supabase, sessionId)

        if (isMounted) {
          setAssignments(combatAssignments)
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
          table: 'game_combat_assignments',
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

      {errorMessage ? <p className="mt-3 text-xs text-red-300">{errorMessage}</p> : null}
    </section>
  )
}
