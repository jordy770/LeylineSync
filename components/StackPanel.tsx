'use client'

import { Layers } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { getErrorMessage } from '@/lib/game/actions'
import { getStackItems } from '@/lib/game/data'
import { enableFallbackRefresh } from '@/lib/game/dev'
import { createClient } from '@/lib/supabase/client'
import type { StackItem } from '@/lib/game/types'

export default function StackPanel({ sessionId }: { sessionId: string }) {
  const supabase = useMemo(() => createClient(), [])
  const [stackItems, setStackItems] = useState<StackItem[]>([])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true

    const loadStack = async () => {
      try {
        const nextStackItems = await getStackItems(supabase, sessionId)

        if (isMounted) {
          setStackItems(nextStackItems)
          setErrorMessage(null)
        }
      } catch (error) {
        const message = getErrorMessage(error)
        console.error('Failed to load stack:', message, error)
        if (isMounted) {
          setErrorMessage(message)
        }
      }
    }

    loadStack()

    const channel = supabase
      .channel(`stack:${sessionId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_stack_items',
          filter: `session_id=eq.${sessionId}`,
        },
        loadStack,
      )
      .subscribe((status, error) => {
        console.log('Stack realtime status:', status)
        if (error) {
          console.error('Stack realtime error:', error)
        }
      })

    const refreshInterval = enableFallbackRefresh ? window.setInterval(loadStack, 2000) : null

    return () => {
      isMounted = false
      if (refreshInterval) {
        window.clearInterval(refreshInterval)
      }
      supabase.removeChannel(channel)
    }
  }, [sessionId, supabase])

  const pendingItems = stackItems.filter((item) => item.status === 'pending')

  return (
    <section className="mb-5 rounded-lg border border-slate-800 bg-slate-950 p-4">
      <div className="mb-3 flex items-center gap-2">
        <Layers className="h-4 w-4 text-sky-300" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-white">Stack</h2>
      </div>

      {pendingItems.length === 0 ? (
        <p className="text-sm text-slate-500">Stack is empty.</p>
      ) : (
        <div className="mb-4 space-y-2">
          {pendingItems.map((item) => (
            <div key={item.id} className="rounded-md bg-slate-900 p-3">
              <p className="text-sm font-semibold text-white">{formatStackAction(item)}</p>
              <p className="text-xs text-slate-500">{formatStackMeta(item)}</p>
            </div>
          ))}
        </div>
      )}

      {errorMessage ? <p className="mt-3 text-xs text-red-300">{errorMessage}</p> : null}
    </section>
  )
}

function formatStackAction(item: StackItem) {
  if (item.action_type === 'deal_damage_player') {
    return `${item.source_card_name ?? 'Unknown source'} deals ${String(
      item.payload.amount ?? 0,
    )} damage to ${item.target_username ?? getTargetFallback(item)}`
  }

  if (item.action_type === 'cast_permanent') {
    return `Cast ${item.source_card_name ?? 'Unknown permanent'}`
  }

  if (item.action_type === 'counter_spell') {
    const targetLabel =
      typeof item.payload.target_stack_label === 'string'
        ? item.payload.target_stack_label
        : 'target spell'

    return `${item.source_card_name ?? 'Counterspell'} counters ${targetLabel}`
  }

  return item.action_type
}

function formatStackMeta(item: StackItem) {
  const controller = item.controller_username ?? 'Unknown player'
  const timing = typeof item.payload.timing === 'string' ? item.payload.timing : null

  return [timing ? timingLabel(timing) : null, `Controller: ${controller}`]
    .filter(Boolean)
    .join(' | ')
}

function getTargetFallback(item: StackItem) {
  return item.target_player_id || item.payload.target_player_id ? 'Unknown player' : 'target'
}

function timingLabel(timing: string) {
  return timing[0]?.toUpperCase() + timing.slice(1)
}
