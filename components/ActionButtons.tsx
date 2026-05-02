'use client' // Cruciaal voor het gebruik van de client en hooks

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  addManaFromCard,
  createManaRetentionEffect,
  getErrorMessage,
  putDealDamagePlayerOnStack,
} from '@/lib/game/actions'
import type { CardAction, CardScript, GameSessionPlayer, GameZone } from '@/lib/game/types'

type CardWithScript = {
  id: string
  is_tapped: boolean
  zone: GameZone
  cards?: {
    script?: CardScript | null
    type_line?: string | null
  } | null
}

interface ActionButtonsProps {
  card: CardWithScript;      // De kaart data inclusief het script
  sessionId: string;
  playerId: string;
  disabled?: boolean;
  sessionPlayers?: GameSessionPlayer[];
  canUseInstantActions?: boolean;
  canUseSorceryActions?: boolean;
}

export default function ActionButtons({
  card,
  sessionId,
  playerId,
  disabled = false,
  sessionPlayers = [],
  canUseInstantActions = false,
  canUseSorceryActions = false,
}: ActionButtonsProps) {
  const supabase = useMemo(() => createClient(), [])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [pendingActionIndex, setPendingActionIndex] = useState<number | null>(null)
  const [selectedTargets, setSelectedTargets] = useState<Record<number, string>>({})
  
  // Haal het script op uit de gejoinde 'cards' tabel
  const script = card.cards?.script;
  const requiresManualTap = script?.triggers?.includes('manual_tap') ?? false

  // Stop als er geen script of acties zijn
  if (!script || !script.actions) return null;

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
      
      console.log(`Mana toegevoegd: ${amount}x ${color}`);
    } catch (err) {
      const message = getErrorMessage(err)
      console.error('Fout bij bijwerken mana:', message, err);
      setErrorMessage(message)
    }
  };

  const handleStackDamageAction = async (
    actionIndex: number,
    targetPlayerId: string,
    amount: number,
    timing: 'instant' | 'sorcery',
  ) => {
    setErrorMessage(null)
    setPendingActionIndex(actionIndex)

    try {
      await putDealDamagePlayerOnStack(supabase, sessionId, targetPlayerId, amount, timing, card.id)
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

  return (
    <div className="space-y-2 p-4">
      <div className="grid grid-cols-2 gap-3">
        {script.actions.map((action, index) => {
          if (action.type === 'add_mana' && action.color && typeof action.amount === 'number') {
            if (card.zone !== 'battlefield') {
              return null
            }

            const color = action.color
            const amount = action.amount
            const isDisabled = disabled || (requiresManualTap && card.is_tapped)

            return (
              <button
                key={index}
                type="button"
                disabled={isDisabled}
                onClick={() => handleManaAction(color, amount)}
                className="flex items-center justify-center gap-2 bg-zinc-800 border border-zinc-700 p-3 rounded-xl transition-transform active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="font-bold text-white">
                  {requiresManualTap ? 'Tap: ' : ''}Add {amount} {color}
                </span>
              </button>
            );
          }

          if (isPlayerDamageAction(action) && typeof action.amount === 'number') {
            const amount = action.amount
            const actionTiming = getActionTiming(action, card.cards?.type_line)
            const canUseTiming =
              actionTiming === 'instant'
                ? canUseInstantActions
                : actionTiming === 'sorcery'
                  ? canUseSorceryActions
                  : false
            const targetPlayerId =
              selectedTargets[index] || sessionPlayers[0]?.player_id || ''
            const isDisabled =
              disabled ||
              !actionTiming ||
              !canUseTiming ||
              !targetPlayerId ||
              pendingActionIndex === index
            const timingLabel = actionTiming ? actionTiming[0].toUpperCase() + actionTiming.slice(1) : 'Stack'

            return (
              <div key={index} className="col-span-2 grid gap-2 rounded-xl border border-slate-700 bg-slate-900 p-3">
                <select
                  value={targetPlayerId}
                  disabled={disabled || sessionPlayers.length === 0 || pendingActionIndex === index}
                  onChange={(event) =>
                    setSelectedTargets((current) => ({
                      ...current,
                      [index]: event.target.value,
                    }))
                  }
                  className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {sessionPlayers.map((player) => (
                    <option key={player.player_id} value={player.player_id}>
                      {player.username || `Player ${player.player_id.slice(0, 8)}`}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={isDisabled}
                  onClick={() =>
                    actionTiming
                      ? handleStackDamageAction(index, targetPlayerId, amount, actionTiming)
                      : undefined
                  }
                  className="flex items-center justify-center gap-2 rounded-md bg-sky-300 p-3 text-sm font-bold text-sky-950 transition-transform active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {pendingActionIndex === index
                    ? 'Adding...'
                    : `${timingLabel}: Deal ${amount} damage`}
                </button>
                {actionTiming === 'instant' && !canUseInstantActions ? (
                  <p className="text-xs text-slate-500">Requires priority.</p>
                ) : null}
                {actionTiming === 'sorcery' && !canUseSorceryActions ? (
                  <p className="text-xs text-slate-500">
                    Sorcery actions require your main phase, priority, and an empty stack.
                  </p>
                ) : null}
                {!actionTiming ? (
                  <p className="text-xs text-slate-500">Set action.timing or use Instant/Sorcery in type_line.</p>
                ) : null}
              </div>
            )
          }

          if (isRetainManaAction(action)) {
            if (card.zone !== 'battlefield') {
              return null
            }

            const colors = getRetainedManaColors(action)
            const isDisabled =
              disabled ||
              colors.length === 0 ||
              !canUseInstantActions ||
              (requiresManualTap && card.is_tapped) ||
              pendingActionIndex === index

            return (
              <button
                key={index}
                type="button"
                disabled={isDisabled}
                onClick={() => handleRetainManaAction(index, action)}
                className="col-span-2 flex items-center justify-center gap-2 rounded-md border border-emerald-700 bg-emerald-950 p-3 text-sm font-bold text-emerald-100 transition-transform active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pendingActionIndex === index
                  ? 'Creating effect...'
                  : `${requiresManualTap ? 'Tap: ' : ''}Keep ${colors.join('/')} mana`}
              </button>
            )
          }
          
          return null;
        })}
      </div>
      {errorMessage ? <p className="text-xs text-red-300">{errorMessage}</p> : null}
    </div>
  );
}

function getActionTiming(action: CardAction, typeLine?: string | null) {
  if (action.timing) {
    return action.timing === 'instant' || action.timing === 'sorcery' ? action.timing : null
  }

  const normalizedTypeLine = typeLine?.toLowerCase() ?? ''

  if (normalizedTypeLine.includes('instant')) {
    return 'instant'
  }

  if (normalizedTypeLine.includes('sorcery')) {
    return 'sorcery'
  }

  return null
}

function isPlayerDamageAction(action: CardAction) {
  if (action.type !== 'deal_damage_player' && action.type !== 'deal_damage') {
    return false
  }

  return !action.target || action.target === 'player'
}

function isRetainManaAction(action: CardAction) {
  return action.type === 'retain_mana' || action.type === 'mana_does_not_empty'
}

function getRetainedManaColors(action: CardAction) {
  if (Array.isArray(action.colors)) {
    return action.colors
      .map((color) => color.toUpperCase())
      .filter((color) => ['W', 'U', 'B', 'R', 'G', 'C'].includes(color))
  }

  if (action.color) {
    return [action.color.toUpperCase()].filter((color) =>
      ['W', 'U', 'B', 'R', 'G', 'C'].includes(color),
    )
  }

  return []
}
