'use client'

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { clearManaPool, getErrorMessage, untapAll } from '@/lib/game/actions'
import DrawCardButton from './DrawCardButton'

export default function PlayerActionPanel({
  sessionId,
  playerId,
  libraryCount,
  tappedBattlefieldCount,
}: {
  sessionId: string
  playerId: string
  libraryCount: number
  tappedBattlefieldCount: number
}) {
  const supabase = useMemo(() => createClient(), [])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isUntapping, setIsUntapping] = useState(false)
  const [isClearingMana, setIsClearingMana] = useState(false)

  const handleUntapAll = async () => {
    setErrorMessage(null)
    setIsUntapping(true)

    try {
      await untapAll(supabase, sessionId, playerId)
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to untap cards:', message, error)
      setErrorMessage(message)
    } finally {
      setIsUntapping(false)
    }
  }

  const handleClearManaPool = async () => {
    setErrorMessage(null)
    setIsClearingMana(true)

    try {
      await clearManaPool(supabase, sessionId, playerId)
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to clear mana pool:', message, error)
      setErrorMessage(message)
    } finally {
      setIsClearingMana(false)
    }
  }

  return (
    <section className="mb-5 rounded-lg border border-slate-800 bg-slate-950 p-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <DrawCardButton sessionId={sessionId} playerId={playerId} libraryCount={libraryCount} />
        <div className="flex items-center justify-between gap-3 rounded-md bg-slate-900 p-3">
          <div>
            <h2 className="text-sm font-semibold text-white">Battlefield</h2>
            <p className="text-xs text-slate-500">{tappedBattlefieldCount} tapped card(s)</p>
          </div>
          <button
            type="button"
            onClick={handleUntapAll}
            disabled={isUntapping || tappedBattlefieldCount === 0}
            className="rounded-md bg-white px-4 py-2 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isUntapping ? 'Untapping...' : 'Untap All'}
          </button>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-md bg-slate-900 p-3">
          <div>
            <h2 className="text-sm font-semibold text-white">Mana</h2>
            <p className="text-xs text-slate-500">Reset pool to zero</p>
          </div>
          <button
            type="button"
            onClick={handleClearManaPool}
            disabled={isClearingMana}
            className="rounded-md bg-white px-4 py-2 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isClearingMana ? 'Clearing...' : 'Clear Mana'}
          </button>
        </div>
      </div>
      {errorMessage ? <p className="mt-3 text-xs text-red-300">{errorMessage}</p> : null}
    </section>
  )
}
