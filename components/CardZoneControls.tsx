'use client'

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { castCardFromHand, getErrorMessage, moveCardToZone } from '@/lib/game/actions'
import { showDevControls } from '@/lib/game/dev'
import {
  decrementPaymentColor,
  getPaymentTotal,
  incrementPaymentColor,
  manaColors,
  normalizeManaPayment,
  parseManaCost,
  type ManaPayment,
} from '@/lib/game/mana'
import type { GameZone } from '@/lib/game/types'

export default function CardZoneControls({
  cardId,
  zone,
  disabled = false,
  sessionId,
  manaCost,
  typeLine,
  landsPlayedThisTurn,
  landPlayLimit = 1,
  canUseSorceryActions = false,
}: {
  cardId: string
  zone: GameZone
  disabled?: boolean
  sessionId?: string
  manaCost?: string | null
  typeLine?: string | null
  landsPlayedThisTurn?: number
  landPlayLimit?: number
  canUseSorceryActions?: boolean
}) {
  const supabase = useMemo(() => createClient(), [])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isCasting, setIsCasting] = useState(false)
  const [genericPayment, setGenericPayment] = useState<ManaPayment>({})

  const move = async (nextZone: GameZone) => {
    setErrorMessage(null)

    try {
      await moveCardToZone(supabase, cardId, nextZone)
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to move card:', message, error)
      setErrorMessage(message)
    }
  }

  const cast = async () => {
    if (!sessionId) {
      setErrorMessage('Session is missing')
      return
    }

    setErrorMessage(null)
    setIsCasting(true)

    try {
      await castCardFromHand(
        supabase,
        sessionId,
        cardId,
        parsedManaCost.generic > 0 ? normalizeManaPayment(genericPayment) : undefined,
      )
      setGenericPayment({})
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to cast card:', message, error)
      setErrorMessage(message)
    } finally {
      setIsCasting(false)
    }
  }

  const normalizedTypeLine = typeLine?.toLowerCase() ?? ''
  const isInstantOrSorcery = normalizedTypeLine.includes('instant') || normalizedTypeLine.includes('sorcery')
  const isLand = normalizedTypeLine.includes('land')
  const resolvedLandPlayLimit = Math.max(1, landPlayLimit)
  const landPlaysUsed = Math.min(landsPlayedThisTurn ?? 0, resolvedLandPlayLimit)
  const landPlaysRemaining = Math.max(0, resolvedLandPlayLimit - landPlaysUsed)
  const playLabel = isLand ? 'Play Land' : manaCost ? `Cast ${manaCost}` : 'Cast'
  const parsedManaCost = parseManaCost(manaCost)
  const selectedGenericPaymentTotal = getPaymentTotal(genericPayment)
  const needsGenericChoice =
    zone === 'hand' &&
    !isInstantOrSorcery &&
    parsedManaCost.generic > 0
  const hasValidGenericChoice =
    !needsGenericChoice || selectedGenericPaymentTotal === parsedManaCost.generic
  const canPlayLand = !isLand || (landPlaysRemaining > 0 && canUseSorceryActions)

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {zone === 'hand' ? (
          <button
            type="button"
            onClick={cast}
            disabled={disabled || isCasting || isInstantOrSorcery || !hasValidGenericChoice || !canPlayLand}
            className="rounded-md bg-emerald-500 px-3 py-2 text-sm font-semibold text-emerald-950 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isCasting ? 'Playing...' : playLabel}
          </button>
        ) : null}
        {showDevControls && zone === 'battlefield' ? (
          <>
            <button
              type="button"
              onClick={() => move('hand')}
              disabled={disabled}
              className="rounded-md bg-slate-700 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              To Hand
            </button>
            <button
              type="button"
              onClick={() => move('graveyard')}
              disabled={disabled}
              className="rounded-md bg-zinc-950 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              Graveyard
            </button>
          </>
        ) : null}
      </div>
      {needsGenericChoice ? (
        <GenericManaPaymentPicker
          genericCost={parsedManaCost.generic}
          payment={genericPayment}
          disabled={disabled || isCasting}
          onIncrement={(color) =>
            setGenericPayment((current) =>
              incrementPaymentColor(current, color, parsedManaCost.generic),
            )
          }
          onDecrement={(color) =>
            setGenericPayment((current) => decrementPaymentColor(current, color))
          }
        />
      ) : null}
      {zone === 'hand' && isInstantOrSorcery ? (
        <p className="text-xs text-slate-500">Use the spell action to cast this card.</p>
      ) : null}
      {zone === 'hand' && isLand ? (
        <p className={landPlaysRemaining > 0 && canUseSorceryActions ? 'text-xs text-emerald-300' : 'text-xs text-slate-500'}>
          Land plays: {landPlaysUsed}/{resolvedLandPlayLimit}
          {!canUseSorceryActions ? ' · requires your main phase, priority, and empty stack' : ''}
        </p>
      ) : null}
      {errorMessage ? <p className="text-xs text-red-300">{errorMessage}</p> : null}
    </div>
  )
}

function GenericManaPaymentPicker({
  genericCost,
  payment,
  disabled,
  onIncrement,
  onDecrement,
}: {
  genericCost: number
  payment: ManaPayment
  disabled: boolean
  onIncrement: (color: (typeof manaColors)[number]) => void
  onDecrement: (color: (typeof manaColors)[number]) => void
}) {
  const selectedTotal = getPaymentTotal(payment)

  return (
    <div className="rounded-md border border-slate-700 bg-slate-900 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-slate-300">Pay generic mana</p>
        <p className="text-xs text-slate-500">
          {selectedTotal}/{genericCost}
        </p>
      </div>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {manaColors.map((color) => (
          <div key={color} className="flex items-center justify-between gap-1 rounded-md bg-slate-950 p-1">
            <button
              type="button"
              disabled={disabled || (payment[color] ?? 0) <= 0}
              onClick={() => onDecrement(color)}
              className="h-7 w-7 rounded bg-slate-800 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              -
            </button>
            <span className="min-w-8 text-center text-xs font-bold text-white">
              {color} {payment[color] ?? 0}
            </span>
            <button
              type="button"
              disabled={disabled || selectedTotal >= genericCost}
              onClick={() => onIncrement(color)}
              className="h-7 w-7 rounded bg-slate-800 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              +
            </button>
          </div>
        ))}
      </div>
      {selectedTotal !== genericCost ? (
        <p className="mt-2 text-xs text-amber-300">Choose exactly {genericCost} mana for the generic cost.</p>
      ) : null}
    </div>
  )
}
