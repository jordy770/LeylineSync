'use client'

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { clearManaPool, devClearManaPool, devUntapAll, getErrorMessage, untapAll } from '@/lib/game/actions'
import { showDevControls } from '@/lib/game/dev'
import DrawCardButton from './DrawCardButton'

export default function PlayerActionPanel({
  sessionId,
  playerId,
  libraryCount,
  handCount = 0,
  tappedBattlefieldCount,
  isSessionFinished = false,
  judgeMode = false,
}: {
  sessionId: string
  playerId: string
  libraryCount: number
  handCount?: number
  tappedBattlefieldCount: number
  isSessionFinished?: boolean
  judgeMode?: boolean
}) {
  const supabase = useMemo(() => createClient(), [])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isUntapping, setIsUntapping] = useState(false)
  const [isClearingMana, setIsClearingMana] = useState(false)

  if (!showDevControls) {
    return null
  }

  const handleUntapAll = async () => {
    setErrorMessage(null)
    setIsUntapping(true)

    try {
      if (judgeMode) {
        await devUntapAll(supabase, sessionId, playerId)
      } else {
        await untapAll(supabase, sessionId, playerId)
      }
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
      if (judgeMode) {
        await devClearManaPool(supabase, sessionId, playerId)
      } else {
        await clearManaPool(supabase, sessionId, playerId)
      }
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to clear mana pool:', message, error)
      setErrorMessage(message)
    } finally {
      setIsClearingMana(false)
    }
  }

  return (
    <section className="rounded-lg border border-white/10 bg-slate-950/55 p-3">
      <div className="grid gap-3 lg:grid-cols-3">
        <DrawCardButton
          sessionId={sessionId}
          playerId={playerId}
          libraryCount={libraryCount}
          handCount={handCount}
          disabled={isSessionFinished}
          judgeMode={judgeMode}
        />
        <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-300/15 bg-amber-950/15 p-3">
          <div>
            <h2 className="text-sm font-semibold text-amber-50">Battlefield</h2>
            <p className="text-xs text-amber-100/55">{tappedBattlefieldCount} tapped card(s)</p>
          </div>
          <button
            type="button"
            onClick={handleUntapAll}
            disabled={isSessionFinished || isUntapping || tappedBattlefieldCount === 0}
            className="rounded-md bg-amber-300 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-amber-300"
          >
            {isUntapping ? 'Untapping...' : 'Untap All'}
          </button>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-300/15 bg-emerald-950/15 p-3">
          <div>
            <h2 className="text-sm font-semibold text-emerald-50">Mana</h2>
            <p className="text-xs text-emerald-100/55">Reset pool to zero</p>
          </div>
          <button
            type="button"
            onClick={handleClearManaPool}
            disabled={isSessionFinished || isClearingMana}
            className="rounded-md bg-emerald-300 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-emerald-300"
          >
            {isClearingMana ? 'Clearing...' : 'Clear Mana'}
          </button>
        </div>
      </div>
      {isSessionFinished ? <p className="mt-3 text-xs text-slate-500">Game is finished. Player actions are locked.</p> : null}
      {errorMessage ? <p className="mt-3 text-xs text-red-300">{errorMessage}</p> : null}
    </section>
  )
}
