'use client'

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getErrorMessage, moveCardToZone } from '@/lib/game/actions'
import type { GameZone } from '@/lib/game/types'

export default function CardZoneControls({
  cardId,
  zone,
}: {
  cardId: string
  zone: GameZone
}) {
  const supabase = useMemo(() => createClient(), [])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

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

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {zone === 'hand' ? (
          <button
            type="button"
            onClick={() => move('battlefield')}
            className="rounded-md bg-emerald-500 px-3 py-2 text-sm font-semibold text-emerald-950"
          >
            Play
          </button>
        ) : null}
        {zone === 'battlefield' ? (
          <>
            <button
              type="button"
              onClick={() => move('hand')}
              className="rounded-md bg-slate-700 px-3 py-2 text-sm font-medium text-white"
            >
              To Hand
            </button>
            <button
              type="button"
              onClick={() => move('graveyard')}
              className="rounded-md bg-zinc-950 px-3 py-2 text-sm font-medium text-white"
            >
              Graveyard
            </button>
          </>
        ) : null}
      </div>
      {errorMessage ? <p className="text-xs text-red-300">{errorMessage}</p> : null}
    </div>
  )
}
