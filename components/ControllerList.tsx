// components/ControllerList.tsx
'use client'
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import CardController from './CardController'

type GameCard = {
  id: string
  name: string
  is_tapped: boolean
}

export default function ControllerList({ sessionId }: { sessionId: string }) {
  const [cards, setCards] = useState<GameCard[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [lastFetchInfo, setLastFetchInfo] = useState<string | null>(null)
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const fetchCards = async () => {
      setErrorMessage(null)

      const { data, error } = await supabase
        .from('game_cards')
        .select('id, name, is_tapped')
        .eq('session_id', sessionId)

      if (error) {
        console.error('Failed to fetch controller cards:', error)
        setErrorMessage(`${error.message}${error.details ? ` (${error.details})` : ''}`)
        setCards([])
      } else {
        setCards(data ?? [])
        setLastFetchInfo(`Session ${sessionId}: ${data?.length ?? 0} card(s) loaded`)
        console.log('Controller cards loaded:', {
          sessionId,
          count: data?.length ?? 0,
          cards: data,
        })
      }

      setIsLoading(false)
    }

    fetchCards()

    const channel = supabase
      .channel(`controller_game_cards:${sessionId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_cards',
          filter: `session_id=eq.${sessionId}`,
        },
        fetchCards,
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [sessionId, supabase])

  if (isLoading) {
    return <p className="text-slate-400">Loading cards...</p>
  }

  if (errorMessage) {
    return (
      <div className="rounded-lg bg-red-950 p-4 text-sm text-red-100">
        Could not load cards: {errorMessage}
      </div>
    )
  }

  if (cards.length === 0) {
    return (
      <div className="rounded-lg bg-slate-900 p-4 text-sm text-slate-300 space-y-2">
        <p>No cards found for session <span className="font-mono">{sessionId}</span>.</p>
        {lastFetchInfo ? <p className="text-slate-500">{lastFetchInfo}</p> : null}
      </div>
    )
  }

  return (
    <>
      {lastFetchInfo ? <p className="mb-3 text-xs text-slate-500">{lastFetchInfo}</p> : null}
      <div className="grid grid-cols-1 gap-4">
        {cards.map((card) => (
          <div key={card.id} className="bg-slate-800 p-4 rounded-xl flex justify-between items-center">
            <span className="text-white font-medium">{card.name}</span>
            <CardController cardId={card.id} isTapped={card.is_tapped} />
          </div>
        ))}
      </div>
    </>
  )
}
