'use client'

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { drawCard, getErrorMessage } from '@/lib/game/actions'

export default function DrawCardButton({
  sessionId,
  playerId,
  libraryCount,
  disabled = false,
}: {
  sessionId: string
  playerId: string
  libraryCount: number
  disabled?: boolean
}) {
  const supabase = useMemo(() => createClient(), [])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isDrawing, setIsDrawing] = useState(false)

  const handleDraw = async () => {
    setErrorMessage(null)
    setIsDrawing(true)

    try {
      await drawCard(supabase, sessionId, playerId)
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to draw card:', message, error)
      setErrorMessage(message)
    } finally {
      setIsDrawing(false)
    }
  }

  return (
    <div className="rounded-md bg-slate-900 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-white">Library</h2>
          <p className="text-xs text-slate-500">{libraryCount} card(s) remaining</p>
        </div>
        <button
          type="button"
          onClick={handleDraw}
          disabled={disabled || isDrawing || libraryCount === 0}
          className="rounded-md bg-white px-4 py-2 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isDrawing ? 'Drawing...' : 'Draw'}
        </button>
      </div>
      {errorMessage ? <p className="mt-3 text-xs text-red-300">{errorMessage}</p> : null}
    </div>
  )
}
