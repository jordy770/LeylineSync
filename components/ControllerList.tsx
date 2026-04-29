// components/ControllerList.tsx
'use client'
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import CardController from './CardController'
import ActionButtons from './ActionButtons'

type CardAction = {
  type: string
  color?: string
  amount?: number
}

type LinkedCard = {
  id: string
  name: string | null
  script: {
    actions?: CardAction[]
    triggers?: string[]
  } | null
  type_line?: string | null
}

type GameCard = {
  id: string
  card_id: string
  name: string
  is_tapped: boolean
  cards: LinkedCard | null
}

type GameCardInstanceRow = {
  id: string
  card_id: string
  is_tapped: boolean
}

export default function ControllerList({ sessionId }: { sessionId: string }) {
  const [cards, setCards] = useState<GameCard[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [lastFetchInfo, setLastFetchInfo] = useState<string | null>(null)
  const [playerId, setPlayerId] = useState<string | null>(null)
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    let isMounted = true
    let currentPlayerId: string | null = null

    const fetchPlayer = async () => {
      const {
        data: { user },
        error,
      } = await supabase.auth.getUser()

      if (error) {
        throw error
      }

      const resolvedPlayerId = user?.id ?? null

      if (isMounted) {
        setPlayerId(resolvedPlayerId)
      }

      return resolvedPlayerId
    }

    const fetchCards = async (currentPlayerId: string) => {
      setErrorMessage(null)

      const { data, error } = await supabase
        .from('game_cards')
        .select(`
          id,
          card_id,
          is_tapped
        `)
        .eq('session_id', sessionId)
        .eq('owner_id', currentPlayerId)

      if (error) {
        console.error('Failed to fetch controller cards:', error)
        if (isMounted) {
          setErrorMessage(`${error.message}${error.details ? ` (${error.details})` : ''}`)
          setCards([])
        }
      } else {
        const gameCardRows = (data ?? []) as GameCardInstanceRow[]
        const cardIds = [...new Set(gameCardRows.map((card) => card.card_id).filter(Boolean))]

        const { data: linkedCardsData, error: linkedCardsError } = cardIds.length
          ? await supabase
              .from('cards')
              .select('id, name, script, type_line')
              .in('id', cardIds)
          : { data: [], error: null }

        if (linkedCardsError) {
          console.error('Failed to fetch linked cards:', linkedCardsError)
          if (isMounted) {
            setErrorMessage(linkedCardsError.message)
            setCards([])
            setIsLoading(false)
          }
          return
        }

        const linkedCardsById = new Map(
          ((linkedCardsData ?? []) as LinkedCard[]).map((card) => [card.id, card]),
        )
        const missingCardIds = cardIds.filter((cardId) => !linkedCardsById.has(cardId))

        const flattenedCards = gameCardRows.map((card) => {
          const linkedCard = linkedCardsById.get(card.card_id) ?? null

          return {
            id: card.id,
            card_id: card.card_id,
            is_tapped: card.is_tapped,
            name: linkedCard?.name ?? `Unknown (${card.card_id})`,
            cards: linkedCard,
          }
        })

        if (isMounted) {
          setCards(flattenedCards)
          setLastFetchInfo(
            missingCardIds.length > 0
              ? `Session ${sessionId}: ${data?.length ?? 0} card(s) loaded, ${missingCardIds.length} card id(s) not found in cards`
              : `Session ${sessionId}: ${data?.length ?? 0} card(s) loaded`,
          )
        }

        console.log('Controller cards loaded:', {
          sessionId,
          count: data?.length ?? 0,
          gameCards: data,
          linkedCards: linkedCardsData,
          missingCardIds,
        })
      }

      if (isMounted) {
        setIsLoading(false)
      }
    }

    const loadControllerCards = async () => {
      try {
        currentPlayerId = currentPlayerId ?? (await fetchPlayer())

        if (!currentPlayerId) {
          if (isMounted) {
            setCards([])
            setLastFetchInfo(`Session ${sessionId}: no signed-in player found`)
            setIsLoading(false)
          }
          return
        }

        await fetchCards(currentPlayerId)
      } catch (error) {
        console.error('Failed to initialize controller cards:', error)
        if (isMounted) {
          setErrorMessage(error instanceof Error ? error.message : 'Could not load controller cards')
          setCards([])
          setIsLoading(false)
        }
      }
    }

    loadControllerCards()

    const channel = supabase
      .channel(`controller:${sessionId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_cards',
          filter: `session_id=eq.${sessionId}`,
        },
        () => {
          if (currentPlayerId) {
            fetchCards(currentPlayerId)
          }
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'cards',
        },
        () => {
          if (currentPlayerId) {
            fetchCards(currentPlayerId)
          }
        },
      )
      .subscribe((status, error) => {
        console.log('Controller realtime status:', status)
        if (error) {
          console.error('Controller realtime error:', error)
        }
      })

    const refreshInterval = window.setInterval(() => {
      if (currentPlayerId) {
        fetchCards(currentPlayerId)
      }
    }, 2000)

    return () => {
      isMounted = false
      window.clearInterval(refreshInterval)
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
          <div key={card.id} className="bg-slate-800 p-4 rounded-xl space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-white font-medium">{card.name}</span>
              <CardController cardId={card.id} isTapped={card.is_tapped} />
            </div>
            {playerId ? (
              <ActionButtons card={card} sessionId={sessionId} playerId={playerId} />
            ) : null}
          </div>
        ))}
      </div>
    </>
  )
}
