// components/ControllerList.tsx
'use client'
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getControllerCards, getCurrentPlayerId } from '@/lib/game/data'
import type { ControllerCard } from '@/lib/game/types'
import CardController from './CardController'
import ActionButtons from './ActionButtons'
import CardZoneControls from './CardZoneControls'
import PlayerActionPanel from './PlayerActionPanel'

export default function ControllerList({ sessionId }: { sessionId: string }) {
  const [cards, setCards] = useState<ControllerCard[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [lastFetchInfo, setLastFetchInfo] = useState<string | null>(null)
  const [playerId, setPlayerId] = useState<string | null>(null)
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    let isMounted = true
    let currentPlayerId: string | null = null

    const fetchPlayer = async () => {
      const resolvedPlayerId = await getCurrentPlayerId(supabase)
      if (isMounted) {
        setPlayerId(resolvedPlayerId)
      }

      return resolvedPlayerId
    }

    const fetchCards = async (currentPlayerId: string) => {
      setErrorMessage(null)

      try {
        const result = await getControllerCards(supabase, sessionId, currentPlayerId)
        if (isMounted) {
          setCards(result.cards)
          setLastFetchInfo(
            result.missingCardIds.length > 0
              ? `Session ${sessionId}: ${result.rowCount} card(s) loaded, ${result.missingCardIds.length} card id(s) not found in cards`
              : `Session ${sessionId}: ${result.rowCount} card(s) loaded`,
          )
        }

        console.log('Controller cards loaded:', {
          sessionId,
          count: result.rowCount,
          cards: result.cards,
          missingCardIds: result.missingCardIds,
        })
      } catch (error) {
        console.error('Failed to fetch controller cards:', error)
        if (isMounted) {
          setErrorMessage(error instanceof Error ? error.message : 'Could not load controller cards')
          setCards([])
        }
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

  const handCards = cards.filter((card) => card.zone === 'hand')
  const battlefieldCards = cards.filter((card) => card.zone === 'battlefield')
  const libraryCount = cards.filter((card) => card.zone === 'library').length
  const tappedBattlefieldCount = battlefieldCards.filter((card) => card.is_tapped).length

  return (
    <>
      {lastFetchInfo ? <p className="mb-3 text-xs text-slate-500">{lastFetchInfo}</p> : null}
      {playerId ? (
        <PlayerActionPanel
          sessionId={sessionId}
          playerId={playerId}
          libraryCount={libraryCount}
          tappedBattlefieldCount={tappedBattlefieldCount}
        />
      ) : null}
      {handCards.length === 0 && battlefieldCards.length === 0 ? (
        <div className="rounded-lg bg-slate-900 p-4 text-sm text-slate-300">
          No cards in hand or on battlefield.
        </div>
      ) : null}
      <CardSection title="Hand" cards={handCards} />
      <CardSection
        title="Battlefield"
        cards={battlefieldCards}
        playerId={playerId}
        sessionId={sessionId}
      />
    </>
  )
}

function CardSection({
  title,
  cards,
  playerId,
  sessionId,
}: {
  title: string
  cards: ControllerCard[]
  playerId?: string | null
  sessionId?: string
}) {
  if (cards.length === 0) {
    return null
  }

  return (
    <section className="mb-5">
      <h2 className="mb-2 text-sm font-semibold text-slate-300">{title}</h2>
      <div className="grid grid-cols-1 gap-4">
        {cards.map((card) => (
          <div key={card.id} className="space-y-3 rounded-lg bg-slate-800 p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-white font-medium">{card.name}</span>
              {card.zone === 'battlefield' ? (
                <CardController cardId={card.id} isTapped={card.is_tapped} />
              ) : null}
            </div>
            <CardZoneControls cardId={card.id} zone={card.zone} />
            {playerId && sessionId && card.zone === 'battlefield' ? (
              <ActionButtons card={card} sessionId={sessionId} playerId={playerId} />
            ) : null}
          </div>
        ))}
      </div>
    </section>
  )
}
