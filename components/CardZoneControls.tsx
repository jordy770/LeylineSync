'use client'

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { castCardFromHand, getErrorMessage, moveCardToZone } from '@/lib/game/actions'
import type { GameZone } from '@/lib/game/types'

export default function CardZoneControls({
  cardId,
  zone,
  disabled = false,
  sessionId,
  manaCost,
  typeLine,
}: {
  cardId: string
  zone: GameZone
  disabled?: boolean
  sessionId?: string
  manaCost?: string | null
  typeLine?: string | null
}) {
  const supabase = useMemo(() => createClient(), [])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isCasting, setIsCasting] = useState(false)

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
      await castCardFromHand(supabase, sessionId, cardId)
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to cast card:', message, error)
      setErrorMessage(message)
    } finally {
      setIsCasting(false)
    }
  }

  const isInstantOrSorcery = typeLine?.toLowerCase().includes('instant') || typeLine?.toLowerCase().includes('sorcery')
  const playLabel = manaCost ? `Play ${manaCost}` : 'Play'

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {zone === 'hand' ? (
          <button
            type="button"
            onClick={cast}
            disabled={disabled || isCasting || isInstantOrSorcery}
            className="rounded-md bg-emerald-500 px-3 py-2 text-sm font-semibold text-emerald-950 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isCasting ? 'Playing...' : playLabel}
          </button>
        ) : null}
        {zone === 'battlefield' ? (
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
      {zone === 'hand' && isInstantOrSorcery ? (
        <p className="text-xs text-slate-500">Use the spell action to cast this card.</p>
      ) : null}
      {errorMessage ? <p className="text-xs text-red-300">{errorMessage}</p> : null}
    </div>
  )
}
