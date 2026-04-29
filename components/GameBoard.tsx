'use client'

import { useEffect, useMemo, useState } from 'react'
import Image from 'next/image'
import { createClient } from '@/lib/supabase/client'
import type { RealtimePostgresChangesPayload, REALTIME_SUBSCRIBE_STATES } from '@supabase/supabase-js'

type GameCard = {
  id: string
  card_id: string
  name: string
  is_tapped: boolean
  position_x: number
  position_y: number
  zone: string
  image_url: string | null
}

type GameCardInstanceRow = {
  id: string
  card_id: string
  position_x: number
  position_y: number
  is_tapped: boolean
  zone: string
}

type LinkedCard = {
  id: string
  name: string | null
  image_url: string | null
}

export default function GameBoard({ sessionId }: { sessionId: string }) {
  const [cards, setCards] = useState<GameCard[]>([])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const fetchCards = async () => {
      const { data, error } = await supabase
        .from('game_cards')
        .select(`
          id,
          card_id,
          position_x,
          position_y,
          is_tapped,
          zone
        `
        )
        .eq('session_id', sessionId)

      if (error) {
        console.error('Failed to fetch board cards:', error)
        setErrorMessage(error.message)
        return
      }

      setErrorMessage(null)

      if (data) {
        const gameCardRows = data as GameCardInstanceRow[]
        const cardIds = [...new Set(gameCardRows.map((card) => card.card_id).filter(Boolean))]

        const { data: linkedCardsData, error: linkedCardsError } = cardIds.length
          ? await supabase
              .from('cards')
              .select('id, name, image_url')
              .in('id', cardIds)
          : { data: [], error: null }

        if (linkedCardsError) {
          console.error('Failed to fetch board linked cards:', linkedCardsError)
          setErrorMessage(linkedCardsError.message)
          return
        }

        const linkedCardsById = new Map(
          ((linkedCardsData ?? []) as LinkedCard[]).map((card) => [card.id, card]),
        )

        const flattenedCards = gameCardRows.map((item) => {
          const linkedCard = linkedCardsById.get(item.card_id) ?? null

          return {
            id: item.id,
            card_id: item.card_id,
            position_x: item.position_x,
            position_y: item.position_y,
            is_tapped: item.is_tapped,
            zone: item.zone,
            name: linkedCard?.name || 'Unknown',
            image_url: linkedCard?.image_url ?? null,
          }
        })

        setCards(flattenedCards)
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
          </div>
        </div>
      ))}
    </div>
  )
}
