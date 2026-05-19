'use client'

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  addManaFromCard,
  createManaRetentionEffect,
  getErrorMessage,
  putCounterSpellOnStack,
  putDealDamagePlayerOnStack,
} from './actions'
import { normalizeManaPayment, type ManaPayment } from './mana'
import { getRetainedManaColors, type CardWithScript } from './action-selectors'
import type { CardAction } from './types'

export function useCardActionHandlers({
  card,
  sessionId,
  playerId,
  requiresManualTap,
}: {
  card: CardWithScript
  sessionId: string
  playerId: string
  requiresManualTap: boolean
}) {
  const supabase = useMemo(() => createClient(), [])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [pendingActionIndex, setPendingActionIndex] = useState<number | null>(null)
  const [selectedTargets, setSelectedTargets] = useState<Record<number, string>>({})
  const [selectedStackTargets, setSelectedStackTargets] = useState<Record<number, string>>({})
  const [genericPayments, setGenericPayments] = useState<Record<number, ManaPayment>>({})

  const handleManaAction = async (color: string, amount: number) => {
    setErrorMessage(null)

    if (requiresManualTap && card.is_tapped) {
      return
    }

    try {
      await addManaFromCard({
        supabase,
        cardId: card.id,
        sessionId,
        playerId,
        color,
        amount,
        shouldTapCard: requiresManualTap,
      })

      console.log(`Mana toegevoegd: ${amount}x ${color}`)
    } catch (err) {
      const message = getErrorMessage(err)
      console.error('Fout bij bijwerken mana:', message, err)
      setErrorMessage(message)
    }
  }

  const handleStackDamageAction = async (
    actionIndex: number,
    targetPlayerId: string,
    amount: number,
    timing: 'instant' | 'sorcery',
    genericPayment?: ManaPayment,
  ) => {
    setErrorMessage(null)
    setPendingActionIndex(actionIndex)

    try {
      await putDealDamagePlayerOnStack(
        supabase,
        sessionId,
        targetPlayerId,
        amount,
        timing,
        card.id,
        genericPayment ? normalizeManaPayment(genericPayment) : undefined,
      )
      clearGenericPayment(actionIndex)
    } catch (err) {
      const message = getErrorMessage(err)
      console.error('Fout bij stack actie:', message, err)
      setErrorMessage(message)
    } finally {
      setPendingActionIndex(null)
    }
  }

  const handleRetainManaAction = async (actionIndex: number, action: CardAction) => {
    setErrorMessage(null)
    setPendingActionIndex(actionIndex)

    try {
      await createManaRetentionEffect({
        supabase,
        sessionId,
        sourceCardId: card.id,
        playerId,
        colors: getRetainedManaColors(action),
        expiresAtPhase: action.expires_at_phase ?? 'ending',
        expiresAtStep: action.expires_at_step ?? 'cleanup',
        shouldTapCard: requiresManualTap,
      })
    } catch (err) {
      const message = getErrorMessage(err)
      console.error('Fout bij mana-retentie effect:', message, err)
      setErrorMessage(message)
    } finally {
      setPendingActionIndex(null)
    }
  }

  const handleCounterSpellAction = async (
    actionIndex: number,
    targetStackItemId: string,
    genericPayment?: ManaPayment,
  ) => {
    setErrorMessage(null)
    setPendingActionIndex(actionIndex)

    try {
      await putCounterSpellOnStack(
        supabase,
        sessionId,
        targetStackItemId,
        card.id,
        genericPayment ? normalizeManaPayment(genericPayment) : undefined,
      )
      clearGenericPayment(actionIndex)
    } catch (err) {
      const message = getErrorMessage(err)
      console.error('Fout bij counterspell actie:', message, err)
      setErrorMessage(message)
    } finally {
      setPendingActionIndex(null)
    }
  }

  function clearGenericPayment(actionIndex: number) {
    setGenericPayments((current) => ({
      ...current,
      [actionIndex]: {},
    }))
  }

  return {
    errorMessage,
    pendingActionIndex,
    selectedTargets,
    selectedStackTargets,
    genericPayments,
    setSelectedTargets,
    setSelectedStackTargets,
    setGenericPayments,
    handleManaAction,
    handleStackDamageAction,
    handleRetainManaAction,
    handleCounterSpellAction,
  }
}
