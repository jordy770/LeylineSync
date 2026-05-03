'use client'

import { useMemo, useState } from 'react'
import {
  getErrorMessage,
  rebuildScriptedContinuousEffects,
  setCardController,
  setCardCopiedScript,
  setCardStaticEffectsSuppressed,
} from '@/lib/game/actions'
import { showDevControls } from '@/lib/game/dev'
import { createClient } from '@/lib/supabase/client'
import type { CardScript, GameSessionPlayer } from '@/lib/game/types'

const copyPresets: Array<{ label: string; script: CardScript | null }> = [
  { label: 'No Copy', script: null },
  {
    label: 'Copy Exploration',
    script: {
      continuous_effects: [
        {
          type: 'additional_land_plays',
          amount: 1,
          affected: 'controller',
          source_zone_required: 'battlefield',
        },
      ],
    },
  },
  {
    label: 'Copy Upwelling',
    script: {
      continuous_effects: [
        {
          type: 'mana_does_not_empty',
          colors: ['W', 'U', 'B', 'R', 'G', 'C'],
          affected: 'all_players',
          source_zone_required: 'battlefield',
        },
      ],
    },
  },
]

export default function StaticEffectControls({
  cardId,
  sessionId,
  controllerPlayerId,
  copiedScript,
  staticEffectsSuppressed = false,
  sessionPlayers = [],
  disabled = false,
}: {
  cardId: string
  sessionId: string
  controllerPlayerId?: string | null
  copiedScript?: CardScript | null
  staticEffectsSuppressed?: boolean
  sessionPlayers?: GameSessionPlayer[]
  disabled?: boolean
}) {
  const supabase = useMemo(() => createClient(), [])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)
  const [selectedController, setSelectedController] = useState(
    controllerPlayerId || sessionPlayers[0]?.player_id || '',
  )

  const activeCopyLabel = copiedScript ? 'Copied' : 'Printed'

  if (!showDevControls) {
    return null
  }

  const runAction = async (action: () => Promise<unknown>) => {
    setErrorMessage(null)
    setIsPending(true)

    try {
      await action()
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to update static effect lifecycle:', message, error)
      setErrorMessage(message)
    } finally {
      setIsPending(false)
    }
  }

  return (
    <div className="rounded-md border border-slate-700 bg-slate-900 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Static effects</p>
        <span className={staticEffectsSuppressed ? 'text-xs text-amber-300' : 'text-xs text-emerald-300'}>
          {staticEffectsSuppressed ? 'Suppressed' : activeCopyLabel}
        </span>
      </div>

      <div className="grid gap-2">
        <button
          type="button"
          disabled={disabled || isPending}
          onClick={() => runAction(() => rebuildScriptedContinuousEffects(supabase, sessionId))}
          className="rounded bg-slate-800 px-3 py-2 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          Rebuild Effects
        </button>

        <button
          type="button"
          disabled={disabled || isPending}
          onClick={() =>
            runAction(() =>
              setCardStaticEffectsSuppressed(supabase, cardId, !staticEffectsSuppressed),
            )
          }
          className="rounded bg-slate-800 px-3 py-2 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {staticEffectsSuppressed ? 'Unsuppress Effects' : 'Suppress Effects'}
        </button>

        <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
          <select
            value={selectedController}
            disabled={disabled || isPending || sessionPlayers.length === 0}
            onChange={(event) => setSelectedController(event.target.value)}
            className="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sessionPlayers.map((player) => (
              <option key={player.player_id} value={player.player_id}>
                {player.username || `Player ${player.player_id.slice(0, 8)}`}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={disabled || isPending || !selectedController}
            onClick={() => runAction(() => setCardController(supabase, cardId, selectedController))}
            className="rounded bg-slate-800 px-3 py-2 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            Set Controller
          </button>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {copyPresets.map((preset) => (
            <button
              key={preset.label}
              type="button"
              disabled={disabled || isPending}
              onClick={() => runAction(() => setCardCopiedScript(supabase, cardId, preset.script))}
              className="rounded bg-slate-800 px-3 py-2 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {errorMessage ? <p className="mt-2 text-xs text-red-300">{errorMessage}</p> : null}
    </div>
  )
}
