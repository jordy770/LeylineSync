'use client'

import { useEffect, useMemo, useState } from 'react'
import CardCatalogPicker from '@/components/CardCatalogPicker'
import { devAddMana, devSetTurnState, devSpawnCard, getErrorMessage } from '@/lib/game/actions'
import { gameZones, turnPhases, turnSteps } from '@/lib/game/data'
import { manaColors } from '@/lib/game/mana'
import { showDevControls } from '@/lib/game/dev'
import { createClient } from '@/lib/supabase/client'
import type { GameSessionPlayer, GameTurnState, GameZone } from '@/lib/game/types'

export default function DevAdminPanel({
  sessionId,
  currentPlayerId,
  sessionPlayers,
  turnState,
  onChanged,
}: {
  sessionId: string
  currentPlayerId: string | null
  sessionPlayers: GameSessionPlayer[]
  turnState: GameTurnState | null
  onChanged?: () => Promise<void> | void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)

  const [manaPlayerId, setManaPlayerId] = useState(currentPlayerId ?? '')
  const [manaColor, setManaColor] = useState<(typeof manaColors)[number]>('G')
  const [manaAmount, setManaAmount] = useState(1)

  const [selectedCardId, setSelectedCardId] = useState('')
  const [spawnPlayerId, setSpawnPlayerId] = useState(currentPlayerId ?? '')
  const [spawnZone, setSpawnZone] = useState<GameZone>('hand')
  const [spawnTapped, setSpawnTapped] = useState(false)

  const [phase, setPhase] = useState<string>(turnState?.phase ?? 'main_1')
  const [step, setStep] = useState<string>(turnState?.step ?? 'precombat_main')
  const [activePlayerId, setActivePlayerId] = useState(turnState?.active_player_id ?? '')
  const [priorityPlayerId, setPriorityPlayerId] = useState(turnState?.priority_player_id ?? '')
  const [turnNumber, setTurnNumber] = useState(turnState?.turn_number ?? 1)

  useEffect(() => {
    if (!currentPlayerId) {
      return
    }

    setManaPlayerId((current) => current || currentPlayerId)
    setSpawnPlayerId((current) => current || currentPlayerId)
  }, [currentPlayerId])

  useEffect(() => {
    if (!turnState) {
      return
    }

    setPhase(turnState.phase)
    setStep(turnState.step)
    setActivePlayerId(turnState.active_player_id)
    setPriorityPlayerId(turnState.priority_player_id ?? turnState.active_player_id)
    setTurnNumber(turnState.turn_number)
  }, [turnState])

  if (!showDevControls) {
    return null
  }

  const runDevAction = async (action: () => Promise<unknown>, success: string) => {
    setErrorMessage(null)
    setSuccessMessage(null)
    setIsPending(true)

    try {
      await action()
      setSuccessMessage(success)
      await onChanged?.()
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Dev admin action failed:', message, error)
      setErrorMessage(message)
    } finally {
      setIsPending(false)
    }
  }

  return (
    <section className="mb-5 rounded-lg border border-fuchsia-900 bg-fuchsia-950/40 p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-fuchsia-100">Dev Admin</h2>
          <p className="text-xs text-fuchsia-300">Visible because NEXT_PUBLIC_SHOW_DEV_CONTROLS=true</p>
        </div>
        {isPending ? <span className="text-xs text-fuchsia-200">Updating...</span> : null}
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="rounded-md bg-slate-950 p-3">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Mana</h3>
          <div className="grid gap-2">
            <PlayerSelect value={manaPlayerId} players={sessionPlayers} onChange={setManaPlayerId} />
            <div className="grid grid-cols-[1fr_96px] gap-2">
              <select
                value={manaColor}
                onChange={(event) => setManaColor(event.target.value as (typeof manaColors)[number])}
                className="rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white"
              >
                {manaColors.map((color) => (
                  <option key={color} value={color}>
                    {color}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={-20}
                max={20}
                value={manaAmount}
                onChange={(event) => setManaAmount(Number(event.target.value))}
                className="rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white"
              />
            </div>
            <button
              type="button"
              disabled={isPending || !manaPlayerId || manaAmount === 0}
              onClick={() =>
                runDevAction(
                  () => devAddMana(supabase, sessionId, manaPlayerId, manaColor, manaAmount),
                  'Mana updated',
                )
              }
              className="rounded bg-fuchsia-300 px-3 py-2 text-sm font-semibold text-fuchsia-950 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Add Mana
            </button>
          </div>
        </div>

        <div className="rounded-md bg-slate-950 p-3">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Spawn Card</h3>
          <div className="grid gap-2">
            <CardCatalogPicker value={selectedCardId} onChange={setSelectedCardId} disabled={isPending} />
            <PlayerSelect value={spawnPlayerId} players={sessionPlayers} onChange={setSpawnPlayerId} />
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <select
                value={spawnZone}
                onChange={(event) => setSpawnZone(event.target.value as GameZone)}
                className="rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white"
              >
                {gameZones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-2 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white">
                <input
                  type="checkbox"
                  checked={spawnTapped}
                  onChange={(event) => setSpawnTapped(event.target.checked)}
                />
                Tapped
              </label>
            </div>
            <button
              type="button"
              disabled={isPending || !selectedCardId || !spawnPlayerId}
              onClick={() =>
                runDevAction(
                  () =>
                    devSpawnCard({
                      supabase,
                      sessionId,
                      playerId: spawnPlayerId,
                      cardId: selectedCardId,
                      zone: spawnZone,
                      tapped: spawnTapped,
                    }),
                  'Card spawned',
                )
              }
              className="rounded bg-fuchsia-300 px-3 py-2 text-sm font-semibold text-fuchsia-950 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Spawn Card
            </button>
          </div>
        </div>

        <div className="rounded-md bg-slate-950 p-3">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Turn State</h3>
          <div className="grid gap-2">
            <select
              value={phase}
              onChange={(event) => setPhase(event.target.value)}
              className="rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white"
            >
              {turnPhases.map((turnPhase) => (
                <option key={turnPhase} value={turnPhase}>
                  {turnPhase}
                </option>
              ))}
            </select>
            <select
              value={step}
              onChange={(event) => setStep(event.target.value)}
              className="rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white"
            >
              {turnSteps.map((turnStep) => (
                <option key={turnStep} value={turnStep}>
                  {turnStep}
                </option>
              ))}
            </select>
            <PlayerSelect value={activePlayerId} players={sessionPlayers} onChange={setActivePlayerId} />
            <PlayerSelect value={priorityPlayerId} players={sessionPlayers} onChange={setPriorityPlayerId} />
            <input
              type="number"
              min={1}
              value={turnNumber}
              onChange={(event) => setTurnNumber(Number(event.target.value))}
              className="rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white"
            />
            <button
              type="button"
              disabled={isPending || !phase || !step || !activePlayerId || !priorityPlayerId}
              onClick={() =>
                runDevAction(
                  () =>
                    devSetTurnState({
                      supabase,
                      sessionId,
                      phase,
                      step,
                      activePlayerId,
                      priorityPlayerId,
                      turnNumber,
                    }),
                  'Turn state updated',
                )
              }
              className="rounded bg-fuchsia-300 px-3 py-2 text-sm font-semibold text-fuchsia-950 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Set Turn State
            </button>
          </div>
        </div>
      </div>

      {successMessage ? <p className="mt-3 text-xs text-emerald-300">{successMessage}</p> : null}
      {errorMessage ? <p className="mt-3 text-xs text-red-300">{errorMessage}</p> : null}
    </section>
  )
}

function PlayerSelect({
  value,
  players,
  onChange,
}: {
  value: string
  players: GameSessionPlayer[]
  onChange: (value: string) => void
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white"
    >
      {players.map((player) => (
        <option key={player.player_id} value={player.player_id}>
          {player.username || `Player ${player.player_id.slice(0, 8)}`}
        </option>
      ))}
    </select>
  )
}
