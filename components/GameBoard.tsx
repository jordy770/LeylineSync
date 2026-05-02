'use client'

import { useEffect, useMemo, useState } from 'react'
import Image from 'next/image'
import { createClient } from '@/lib/supabase/client'
import { getBoardCards } from '@/lib/game/data'
import type { BoardCard } from '@/lib/game/types'
import type { RealtimePostgresChangesPayload, REALTIME_SUBSCRIBE_STATES } from '@supabase/supabase-js'

export default function GameBoard({ sessionId }: { sessionId: string }) {
  const [cards, setCards] = useState<BoardCard[]>([])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const fetchCards = async () => {
      try {
        const boardCards = await getBoardCards(supabase, sessionId)
        setErrorMessage(null)
        setCards(boardCards)
      } catch (error) {
        console.error('Failed to fetch board cards:', error)
        setErrorMessage(error instanceof Error ? error.message : 'Could not load board cards')
      }
    }

    fetchCards()

    const channel = supabase
      .channel(`board:${sessionId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_cards',
          filter: `session_id=eq.${sessionId}`,
        },
        (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
          console.log('Board received realtime update:', payload)
          fetchCards()
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'cards',
        },
        (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
          console.log('Board received card metadata update:', payload)
          fetchCards()
        },
      )
      .subscribe((status: `${REALTIME_SUBSCRIBE_STATES}`, error?: Error) => {
        console.log('Board realtime status:', status)
        if (error) {
          console.error('Board realtime error:', error)
        }
      })

    const refreshInterval = window.setInterval(fetchCards, 2000)

    return () => {
      window.clearInterval(refreshInterval)
      supabase.removeChannel(channel)
    }
  }, [sessionId, supabase])

  if (errorMessage) {
    return (
      <div className="p-6">
        <div className="rounded-lg bg-red-950 p-4 text-sm text-red-100">
          Could not load board cards: {errorMessage}
        </div>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4 p-6">
      {cards.map((card) => (
        <div
          key={card.id}
          className={`rounded-lg bg-slate-800 p-4 text-white transition-transform ${
            card.is_tapped ? 'rotate-90 opacity-70' : ''
          }`}
        >
          <div className="relative aspect-[2/3] overflow-hidden rounded-md bg-slate-700">
            {card.image_url ? (
              <Image
                src={card.image_url}
                alt={card.name || 'Magic card'}
                fill
                sizes="(min-width: 768px) 25vw, (min-width: 640px) 33vw, 50vw"
                className="object-cover"
              />
            ) : (
              <div className="flex h-full items-center justify-center p-3 text-center font-medium">
                {card.name || 'Unnamed Card'}
              </div>
            )}
            {card.damage_marked > 0 ? (
              <div className="absolute right-2 top-2 rounded-full bg-red-500 px-2 py-1 text-xs font-bold text-white shadow">
                {card.damage_marked}
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  )
}
