'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getCurrentPlayerId, getPlayerManaPool, normalizeManaPool } from '@/lib/game/data'
import type { ManaColor, ManaPool as ManaPoolType } from '@/lib/game/types'
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'

const manaColors: Array<{
  color: ManaColor
  label: string
  className: string
}> = [
  { color: 'W', label: 'White', className: 'bg-stone-100 text-stone-950 border-stone-300' },
  { color: 'U', label: 'Blue', className: 'bg-sky-500 text-white border-sky-300' },
  { color: 'B', label: 'Black', className: 'bg-zinc-950 text-white border-zinc-700' },
  { color: 'R', label: 'Red', className: 'bg-red-600 text-white border-red-400' },
  { color: 'G', label: 'Green', className: 'bg-emerald-600 text-white border-emerald-400' },
  { color: 'C', label: 'Colorless', className: 'bg-neutral-300 text-neutral-950 border-neutral-500' },
]

type GamePlayerRealtimeRow = {
  session_id?: string
  player_id?: string
  mana_pool?: ManaPoolType | null
}

export default function ManaPool({ sessionId }: { sessionId: string }) {
  const supabase = useMemo(() => createClient(), [])
  const [manaPool, setManaPool] = useState<ManaPoolType>(() => normalizeManaPool(null))
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [playerId, setPlayerId] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true
    let currentPlayerId: string | null = null

    const loadManaPool = async () => {
      try {
        currentPlayerId = currentPlayerId ?? (await getCurrentPlayerId(supabase))

        if (!currentPlayerId) {
          if (isMounted) {
            setPlayerId(null)
            setManaPool(normalizeManaPool(null))
            setErrorMessage('No signed-in player found')
            setIsLoading(false)
          }
          return
        }

        const pool = await getPlayerManaPool(supabase, sessionId, currentPlayerId)

        if (isMounted) {
          setPlayerId(currentPlayerId)
          setManaPool(pool)
          setErrorMessage(null)
          setIsLoading(false)
        }
      } catch (error) {
        console.error('Failed to load mana pool:', error)
        if (isMounted) {
          setErrorMessage(error instanceof Error ? error.message : 'Could not load mana pool')
          setIsLoading(false)
        }
      }
    }

    loadManaPool()

    const channel = supabase
      .channel(`mana-pool:${sessionId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_players',
          filter: `session_id=eq.${sessionId}`,
        },
        (payload: RealtimePostgresChangesPayload<GamePlayerRealtimeRow>) => {
          const nextRow = (payload.new ?? null) as GamePlayerRealtimeRow | null

          if (!currentPlayerId || nextRow?.player_id !== currentPlayerId) {
            return
          }

          setManaPool(normalizeManaPool(nextRow.mana_pool))
          setErrorMessage(null)
        },
      )
      .subscribe((status, error) => {
        console.log('Mana pool realtime status:', status)
        if (error) {
          console.error('Mana pool realtime error:', error)
        }
      })

    const refreshInterval = window.setInterval(loadManaPool, 2000)

    return () => {
      isMounted = false
      window.clearInterval(refreshInterval)
      supabase.removeChannel(channel)
    }
  }, [sessionId, supabase])

  return (
    <section className="mb-5 rounded-lg border border-slate-800 bg-slate-950 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-white">Mana Pool</h2>
        <span className="truncate text-xs text-slate-500">
          {playerId ? `Player ${playerId.slice(0, 8)}` : 'No player'}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {manaColors.map((item) => (
          <div
            key={item.color}
            title={item.label}
            className={`flex min-h-16 flex-col items-center justify-center rounded-md border px-2 py-2 ${item.className}`}
          >
            <span className="text-xs font-bold">{item.color}</span>
            <span className="text-2xl font-bold leading-none">{manaPool[item.color] ?? 0}</span>
          </div>
        ))}
      </div>

      {isLoading ? <p className="mt-3 text-xs text-slate-500">Loading mana...</p> : null}
      {errorMessage ? <p className="mt-3 text-xs text-red-300">{errorMessage}</p> : null}
    </section>
  )
}
