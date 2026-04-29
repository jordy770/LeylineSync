'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

type GameCard = {
  id: string
  name: string
  is_tapped: boolean
}

export default function GameBoard({ sessionId }: { sessionId: string }) {
  const [cards, setCards] = useState<GameCard[]>([])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const fetchCards = async () => {
      const { data, error } = await supabase
        .from('game_cards')
        .select('id, name, is_tapped')
        .eq('session_id', sessionId)

      if (error) {
        console.error('Failed to fetch board cards:', error)
        setErrorMessage(error.message)
        return
      }

      setErrorMessage(null)
      setCards(data ?? [])
    }

    fetchCards()

    const channel = supabase
      .channel(`game_cards:${sessionId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_cards',
          filter: `session_id=eq.${sessionId}`,
        },
        (payload) => {
          console.log('Board received realtime update:', payload)
          fetchCards()
        },
      )
      .subscribe((status, error) => {
        console.log('Board realtime status:', status)
        if (error) {
          console.error('Board realtime error:', error)
        }
      })

    return () => {
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
          <div className="aspect-[2/3] rounded-md bg-slate-700 p-3 flex items-center justify-center text-center font-medium">
            {card.name}
          </div>
        </div>
      ))}
    </div>
  )
}
