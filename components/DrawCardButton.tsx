'use client'

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { devDrawCard, devUndoLastDraw, drawCard, getErrorMessage } from '@/lib/game/actions'

export default function DrawCardButton({
  sessionId,
  playerId,
  libraryCount,
  handCount = 0,
  disabled = false,
  judgeMode = false,
}: {
  sessionId: string
  playerId: string
  libraryCount: number
  handCount?: number
  disabled?: boolean
  judgeMode?: boolean
}) {
  const supabase = useMemo(() => createClient(), [])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isDrawing, setIsDrawing] = useState(false)
  const [isUndoing, setIsUndoing] = useState(false)

  const handleDraw = async () => {
    setErrorMessage(null)
    setIsDrawing(true)

    try {
      if (judgeMode) {
        await devDrawCard(supabase, sessionId, playerId)
      } else {
        await drawCard(supabase, sessionId, playerId)
      }
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to draw card:', message, error)
      setErrorMessage(message)
    } finally {
      setIsDrawing(false)
    }
  }

  const handleUndoDraw = async () => {
    setErrorMessage(null)
    setIsUndoing(true)

    try {
      await devUndoLastDraw(supabase, sessionId, playerId)
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to undo draw:', message, error)
      setErrorMessage(message)
    } finally {
      setIsUndoing(false)
    }
  }

  return (
    <div className="rounded-lg border border-cyan-300/15 bg-cyan-950/20 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-cyan-50">Library</h2>
          <p className="text-xs text-cyan-100/55">
            {libraryCount} card(s) remaining{judgeMode ? ` - ${handCount} in hand` : ''}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {judgeMode ? (
            <button
              type="button"
              onClick={handleUndoDraw}
              disabled={disabled || isUndoing || handCount === 0}
              className="rounded-md border border-white/15 bg-slate-950/70 px-3 py-2 text-sm font-semibold text-slate-100 transition hover:border-cyan-300/35 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-white/15"
            >
              {isUndoing ? 'Undoing...' : 'Undo'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={handleDraw}
            disabled={disabled || isDrawing || libraryCount === 0}
            className="rounded-md bg-cyan-300 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-cyan-300"
          >
            {isDrawing ? 'Drawing...' : 'Draw'}
          </button>
        </div>
      </div>
      {errorMessage ? <p className="mt-3 text-xs text-red-300">{errorMessage}</p> : null}
    </div>
  )
}
