'use client' // Cruciaal voor het gebruik van de client en hooks

import {
  formatStackTargetLabel,
  getActionTiming,
  getRetainedManaColors,
  isCounterSpellAction,
  isPlayerDamageAction,
  isRetainManaAction,
  type CardWithScript,
} from '@/lib/game/action-selectors'
import { useCardActionHandlers } from '@/lib/game/use-card-action-handlers'
import {
  decrementPaymentColor,
  getPaymentTotal,
  incrementPaymentColor,
  manaColors,
  parseManaCost,
  type ManaPayment,
} from '@/lib/game/mana'
import type { GameSessionPlayer, StackItem } from '@/lib/game/types'

interface ActionButtonsProps {
  card: CardWithScript;      // De kaart data inclusief het script
  sessionId: string;
  playerId: string;
  disabled?: boolean;
  sessionPlayers?: GameSessionPlayer[];
  stackItems?: StackItem[];
  canUseInstantActions?: boolean;
  canUseSorceryActions?: boolean;
}

export default function ActionButtons({
  card,
  sessionId,
  playerId,
  disabled = false,
  sessionPlayers = [],
  stackItems = [],
  canUseInstantActions = false,
  canUseSorceryActions = false,
}: ActionButtonsProps) {
  // Haal het script op uit de gejoinde 'cards' tabel
  const script = card.cards?.script;
  const requiresManualTap = script?.triggers?.includes('manual_tap') ?? false
  const {
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
  } = useCardActionHandlers({
    card,
    sessionId,
    playerId,
    requiresManualTap,
  })

  // Stop als er geen script of acties zijn
  if (!script || !script.actions) return null;

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
            const parsedManaCost = parseManaCost(card.cards?.mana_cost)
            const needsGenericChoice = card.zone === 'hand' && parsedManaCost.generic > 0
            const genericPayment = genericPayments[index] ?? {}
            const selectedGenericPaymentTotal = getPaymentTotal(genericPayment)
            const hasValidGenericChoice =
              !needsGenericChoice || selectedGenericPaymentTotal === parsedManaCost.generic
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
              !hasValidGenericChoice ||
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
                {needsGenericChoice ? (
                  <GenericManaPaymentPicker
                    genericCost={parsedManaCost.generic}
                    payment={genericPayment}
                    disabled={disabled || pendingActionIndex === index}
                    onIncrement={(color) =>
                      setGenericPayments((current) => ({
                        ...current,
                        [index]: incrementPaymentColor(genericPayment, color, parsedManaCost.generic),
                      }))
                    }
                    onDecrement={(color) =>
                      setGenericPayments((current) => ({
                        ...current,
                        [index]: decrementPaymentColor(genericPayment, color),
                      }))
                    }
                  />
                ) : null}
                <button
                  type="button"
                  disabled={isDisabled}
                  onClick={() =>
                    actionTiming
                      ? handleStackDamageAction(
                          index,
                          targetPlayerId,
                          amount,
                          actionTiming,
                          needsGenericChoice ? genericPayment : undefined,
                        )
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

          if (isCounterSpellAction(action)) {
            if (card.zone !== 'hand') {
              return null
            }

            const pendingStackItems = stackItems.filter((item) => item.status === 'pending')
            const parsedManaCost = parseManaCost(card.cards?.mana_cost)
            const needsGenericChoice = card.zone === 'hand' && parsedManaCost.generic > 0
            const genericPayment = genericPayments[index] ?? {}
            const selectedGenericPaymentTotal = getPaymentTotal(genericPayment)
            const hasValidGenericChoice =
              !needsGenericChoice || selectedGenericPaymentTotal === parsedManaCost.generic
            const targetStackItemId =
              selectedStackTargets[index] || pendingStackItems[0]?.id || ''
            const isDisabled =
              disabled ||
              !canUseInstantActions ||
              !targetStackItemId ||
              !hasValidGenericChoice ||
              pendingActionIndex === index

            return (
              <div key={index} className="col-span-2 grid gap-2 rounded-xl border border-violet-700 bg-violet-950/40 p-3">
                <select
                  value={targetStackItemId}
                  disabled={disabled || pendingStackItems.length === 0 || pendingActionIndex === index}
                  onChange={(event) =>
                    setSelectedStackTargets((current) => ({
                      ...current,
                      [index]: event.target.value,
                    }))
                  }
                  className="rounded-md border border-violet-800 bg-slate-950 px-3 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {pendingStackItems.length === 0 ? (
                    <option value="">Stack is empty</option>
                  ) : (
                    pendingStackItems.map((item) => (
                      <option key={item.id} value={item.id}>
                        {formatStackTargetLabel(item)}
                      </option>
                    ))
                  )}
                </select>
                {needsGenericChoice ? (
                  <GenericManaPaymentPicker
                    genericCost={parsedManaCost.generic}
                    payment={genericPayment}
                    disabled={disabled || pendingActionIndex === index}
                    onIncrement={(color) =>
                      setGenericPayments((current) => ({
                        ...current,
                        [index]: incrementPaymentColor(genericPayment, color, parsedManaCost.generic),
                      }))
                    }
                    onDecrement={(color) =>
                      setGenericPayments((current) => ({
                        ...current,
                        [index]: decrementPaymentColor(genericPayment, color),
                      }))
                    }
                  />
                ) : null}
                <button
                  type="button"
                  disabled={isDisabled}
                  onClick={() =>
                    handleCounterSpellAction(
                      index,
                      targetStackItemId,
                      needsGenericChoice ? genericPayment : undefined,
                    )
                  }
                  className="flex items-center justify-center gap-2 rounded-md bg-violet-300 p-3 text-sm font-bold text-violet-950 transition-transform active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {pendingActionIndex === index ? 'Adding...' : 'Instant: Counter target spell'}
                </button>
                {!canUseInstantActions ? (
                  <p className="text-xs text-slate-500">Requires priority.</p>
                ) : null}
                {pendingStackItems.length === 0 ? (
                  <p className="text-xs text-slate-500">There are no pending stack items to counter.</p>
                ) : null}
              </div>
            )
          }
          
          return null;
        })}
      </div>
      {errorMessage ? <p className="text-xs text-red-300">{errorMessage}</p> : null}
    </div>
  );
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
    <div className="rounded-md border border-slate-700 bg-slate-950 p-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-slate-300">Pay generic mana</p>
        <p className="text-xs text-slate-500">
          {selectedTotal}/{genericCost}
        </p>
      </div>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {manaColors.map((color) => (
          <div key={color} className="flex items-center justify-between gap-1 rounded bg-slate-900 p-1">
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
