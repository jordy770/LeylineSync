'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  devMoveCardToZone,
  devPutCardOnBottom,
  devPutCardOnTop,
  devSetCardDamage,
  devSetCardTapped,
  devShuffleLibrary,
  getErrorMessage,
} from './actions'
import type { ControllerCard, GameZone } from './types'

export function useJudgeCardTools({
  sessionId,
  playerId,
  cards,
  onChanged,
}: {
  sessionId: string
  playerId: string
  cards: ControllerCard[]
  onChanged: () => Promise<void>
}) {
  const supabase = useMemo(() => createClient(), [])
  const visibleCards = useMemo(() => cards.filter((card) => card.zone !== 'library'), [cards])
  const [selectedCardId, setSelectedCardId] = useState(visibleCards[0]?.id ?? '')
  const [targetZone, setTargetZone] = useState<GameZone>('graveyard')
  const [damageMarked, setDamageMarked] = useState(0)
  const [isPending, setIsPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const selectedCard = visibleCards.find((card) => card.id === selectedCardId) ?? visibleCards[0] ?? null

  useEffect(() => {
    if (selectedCardId && visibleCards.some((card) => card.id === selectedCardId)) {
      return
    }

    setSelectedCardId(visibleCards[0]?.id ?? '')
  }, [selectedCardId, visibleCards])

  useEffect(() => {
    setDamageMarked(selectedCard?.damage_marked ?? 0)
  }, [selectedCard?.id, selectedCard?.damage_marked])

  const runJudgeAction = async (action: () => Promise<unknown>, success: string) => {
    setIsPending(true)
    setMessage(null)

    try {
      await action()
      setMessage(success)
      await onChanged()
    } catch (error) {
      const nextMessage = getErrorMessage(error)
      console.error('Judge card action failed:', nextMessage, error)
      setMessage(nextMessage)
    } finally {
      setIsPending(false)
    }
  }

  return {
    visibleCards,
    selectedCard,
    selectedCardId,
    targetZone,
    damageMarked,
    isPending,
    message,
    setSelectedCardId,
    setTargetZone,
    setDamageMarked,
    shuffleLibrary: () =>
      runJudgeAction(
        () => devShuffleLibrary(supabase, sessionId, playerId),
        'Library shuffled',
      ),
    moveSelectedCard: () =>
      selectedCard
        ? runJudgeAction(
            () => devMoveCardToZone(supabase, sessionId, selectedCard.id, targetZone),
            `Moved to ${targetZone}`,
          )
        : Promise.resolve(),
    toggleSelectedCardTapped: () =>
      selectedCard
        ? runJudgeAction(
            () => devSetCardTapped(supabase, sessionId, selectedCard.id, !selectedCard.is_tapped),
            selectedCard.is_tapped ? 'Card untapped' : 'Card tapped',
          )
        : Promise.resolve(),
    updateSelectedCardDamage: () =>
      selectedCard
        ? runJudgeAction(
            () => devSetCardDamage(supabase, sessionId, selectedCard.id, damageMarked),
            'Damage updated',
          )
        : Promise.resolve(),
    putSelectedCardOnTop: () =>
      selectedCard
        ? runJudgeAction(
            () => devPutCardOnTop(supabase, sessionId, selectedCard.id),
            'Moved to top of library',
          )
        : Promise.resolve(),
    putSelectedCardOnBottom: () =>
      selectedCard
        ? runJudgeAction(
            () => devPutCardOnBottom(supabase, sessionId, selectedCard.id),
            'Moved to bottom of library',
          )
        : Promise.resolve(),
  }
}
