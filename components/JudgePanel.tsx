'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import CombatAssignmentsPanel from '@/components/CombatAssignmentsPanel'
import DevAdminPanel from '@/components/DevAdminPanel'
import GameStatusPanel from '@/components/GameStatusPanel'
import LifeTotalsPanel from '@/components/LifeTotalsPanel'
import PlayerActionPanel from '@/components/PlayerActionPanel'
import StackPanel from '@/components/StackPanel'
import TurnStatusPanel from '@/components/TurnStatusPanel'
import { gameZones, getControllerCards, getGameActionLogs, getGameSession, getGameSessionPlayers, getPlayerManaPool, getTurnState } from '@/lib/game/data'
import { enableFallbackRefresh, fallbackRefreshIntervalMs, showDevControls } from '@/lib/game/dev'
import {
  devMoveCardToZone,
  devPutCardOnBottom,
  devPutCardOnTop,
  devSetCardDamage,
  devSetCardTapped,
  devShuffleLibrary,
  devUndoAction,
  getErrorMessage,
} from '@/lib/game/actions'
import { createClient } from '@/lib/supabase/client'
import type { ControllerCard, GameActionLog, GameSessionPlayer, GameTurnState, GameZone, ManaColor, ManaPool } from '@/lib/game/types'

type PlayerJudgeStats = {
  libraryCount: number
  handCount: number
  tappedBattlefieldCount: number
  manaPool: ManaPool
  cards: ControllerCard[]
}

const manaColorsForDisplay: Array<{
  color: ManaColor
  label: string
  className: string
}> = [
  { color: 'W', label: 'White', className: 'border-stone-300 bg-stone-100 text-stone-950' },
  { color: 'U', label: 'Blue', className: 'border-sky-300 bg-sky-500 text-white' },
  { color: 'B', label: 'Black', className: 'border-zinc-700 bg-zinc-950 text-white' },
  { color: 'R', label: 'Red', className: 'border-red-400 bg-red-600 text-white' },
  { color: 'G', label: 'Green', className: 'border-emerald-400 bg-emerald-600 text-white' },
  { color: 'C', label: 'Colorless', className: 'border-neutral-500 bg-neutral-300 text-neutral-950' },
]

export default function JudgePanel({ sessionId }: { sessionId: string }) {
  const supabase = useMemo(() => createClient(), [])
  const [sessionStatus, setSessionStatus] = useState<string>('loading')
  const [sessionPlayers, setSessionPlayers] = useState<GameSessionPlayer[]>([])
  const [turnState, setTurnState] = useState<GameTurnState | null>(null)
  const [actionLogs, setActionLogs] = useState<GameActionLog[]>([])
  const [playerStats, setPlayerStats] = useState<Record<string, PlayerJudgeStats>>({})
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const loadJudgeContext = useCallback(async () => {
    try {
      const [session, players, nextTurnState, nextActionLogs] = await Promise.all([
        getGameSession(supabase, sessionId),
        getGameSessionPlayers(supabase, sessionId),
        getTurnState(supabase, sessionId),
        getGameActionLogs(supabase, sessionId),
      ])

      const statsEntries = await Promise.all(
        players.map(async (player) => {
          const [result, manaPool] = await Promise.all([
            getControllerCards(supabase, sessionId, player.player_id),
            getPlayerManaPool(supabase, sessionId, player.player_id),
          ])
          const stats: PlayerJudgeStats = {
            libraryCount: result.cards.filter((card) => card.zone === 'library').length,
            handCount: result.cards.filter((card) => card.zone === 'hand').length,
            tappedBattlefieldCount: result.cards.filter((card) => card.zone === 'battlefield' && card.is_tapped).length,
            manaPool,
            cards: result.cards,
          }

          return [player.player_id, stats] as const
        }),
      )

      setSessionStatus(session?.status ?? 'missing')
      setSessionPlayers(players)
      setTurnState(nextTurnState)
      setActionLogs(nextActionLogs)
      setPlayerStats(Object.fromEntries(statsEntries))
      setErrorMessage(null)
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to load judge context:', message, error)
      setErrorMessage(message)
    }
  }, [sessionId, supabase])

  useEffect(() => {
    loadJudgeContext()

    const channel = supabase
      .channel(`judge:${sessionId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'game_sessions', filter: `id=eq.${sessionId}` },
        loadJudgeContext,
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'game_cards', filter: `session_id=eq.${sessionId}` },
        loadJudgeContext,
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'game_players', filter: `session_id=eq.${sessionId}` },
        loadJudgeContext,
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'game_session_players', filter: `session_id=eq.${sessionId}` },
        loadJudgeContext,
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'game_turn_state', filter: `session_id=eq.${sessionId}` },
        loadJudgeContext,
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'game_action_log', filter: `session_id=eq.${sessionId}` },
        loadJudgeContext,
      )
      .subscribe((status, error) => {
        console.log('Judge realtime status:', status)
        if (error) {
          console.error('Judge realtime error:', error)
        }
      })

    const refreshInterval = enableFallbackRefresh ? window.setInterval(loadJudgeContext, fallbackRefreshIntervalMs) : null

    return () => {
      if (refreshInterval) {
        window.clearInterval(refreshInterval)
      }
      supabase.removeChannel(channel)
    }
  }, [loadJudgeContext, sessionId, supabase])

  if (!showDevControls) {
    return (
      <section className="leyline-glass-panel rounded-lg p-5 text-sm text-amber-100">
        Judge tools are disabled. Set NEXT_PUBLIC_SHOW_DEV_CONTROLS=true to expose this page.
      </section>
    )
  }

  const firstPlayerId = sessionPlayers[0]?.player_id ?? null
  const isSessionFinished = sessionStatus === 'finished'

  return (
    <div className="grid gap-5">
      <section className="leyline-glass-panel rounded-lg p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-300/80">Judge Console</p>
            <h1 className="text-xl font-bold text-white">Session Admin</h1>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-md border border-white/10 bg-slate-950/60 px-3 py-1.5 text-slate-300">
              Status: {sessionStatus}
            </span>
            <span className="rounded-md border border-white/10 bg-slate-950/60 px-3 py-1.5 text-slate-300">
              Players: {sessionPlayers.length}
            </span>
          </div>
        </div>
      </section>

      {errorMessage ? (
        <div className="rounded-lg border border-red-300/25 bg-red-950/40 p-3 text-sm text-red-100">
          {errorMessage}
        </div>
      ) : null}

      <DevAdminPanel
        sessionId={sessionId}
        currentPlayerId={firstPlayerId}
        sessionPlayers={sessionPlayers}
        turnState={turnState}
        onChanged={loadJudgeContext}
      />

      <RecentJudgeActions actions={actionLogs} players={sessionPlayers} onChanged={loadJudgeContext} />

      <section className="grid gap-4 2xl:grid-cols-2">
        {sessionPlayers.map((player) => {
          const stats = playerStats[player.player_id] ?? {
            libraryCount: 0,
            handCount: 0,
            tappedBattlefieldCount: 0,
            manaPool: {},
            cards: [],
          }

          return (
            <div key={player.player_id} className="leyline-glass-panel rounded-lg p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-300">
                    Player {player.seat_number}
                  </p>
                  <h2 className="text-base font-bold text-white">{player.username ?? player.player_id.slice(0, 8)}</h2>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <JudgeStatChip label="Life" value={player.life_total} tone="life" />
                  <JudgeStatChip label="Hand" value={stats.handCount} tone="hand" />
                  <JudgeStatChip label="Library" value={stats.libraryCount} tone="library" />
                  <JudgeStatChip label="Tapped" value={stats.tappedBattlefieldCount} tone="tapped" />
                </div>
              </div>
              <PlayerActionPanel
                sessionId={sessionId}
                playerId={player.player_id}
                libraryCount={stats.libraryCount}
                handCount={stats.handCount}
                tappedBattlefieldCount={stats.tappedBattlefieldCount}
                isSessionFinished={isSessionFinished}
                judgeMode
              />
              <PlayerManaPool manaPool={stats.manaPool} />
              <JudgePlayerCardTools
                sessionId={sessionId}
                playerId={player.player_id}
                cards={stats.cards}
                isSessionFinished={isSessionFinished}
                onChanged={loadJudgeContext}
              />
            </div>
          )
        })}
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <GameStatusPanel sessionId={sessionId} />
        <TurnStatusPanel sessionId={sessionId} />
        <StackPanel sessionId={sessionId} />
        <LifeTotalsPanel sessionId={sessionId} />
        <CombatAssignmentsPanel sessionId={sessionId} />
      </section>
    </div>
  )
}

function JudgeStatChip({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'life' | 'hand' | 'library' | 'tapped'
}) {
  const toneClassName =
    tone === 'life'
      ? 'border-cyan-300/25 bg-cyan-950/35 text-cyan-100'
      : tone === 'hand'
        ? 'border-violet-300/20 bg-violet-950/25 text-violet-100'
        : tone === 'library'
          ? 'border-slate-300/15 bg-slate-950/55 text-slate-100'
          : 'border-amber-300/25 bg-amber-950/25 text-amber-100'

  return (
    <span className={`rounded-md border px-2.5 py-1 text-xs font-semibold ${toneClassName}`}>
      <span className="mr-1 text-[10px] uppercase tracking-[0.12em] opacity-60">{label}</span>
      {value}
    </span>
  )
}

function PlayerManaPool({ manaPool }: { manaPool: ManaPool }) {
  return (
    <div className="mt-3 rounded-lg border border-white/10 bg-slate-950/55 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">Mana Pool</h3>
        <span className="text-xs text-slate-500">
          Total {manaColorsForDisplay.reduce((total, item) => total + (manaPool[item.color] ?? 0), 0)}
        </span>
      </div>
      <div className="grid grid-cols-6 gap-1.5">
        {manaColorsForDisplay.map((item) => (
          <div
            key={item.color}
            title={item.label}
            className={`flex min-h-10 flex-col items-center justify-center rounded-md border px-1 py-1 ${item.className}`}
          >
            <span className="text-[10px] font-bold leading-none">{item.color}</span>
            <span className="text-sm font-bold leading-none">{manaPool[item.color] ?? 0}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function RecentJudgeActions({
  actions,
  players,
  onChanged,
}: {
  actions: GameActionLog[]
  players: GameSessionPlayer[]
  onChanged: () => Promise<void>
}) {
  const supabase = useMemo(() => createClient(), [])
  const [pendingActionId, setPendingActionId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const getPlayerLabel = (playerId?: string | null) => {
    const player = players.find((item) => item.player_id === playerId)
    return player?.username ?? (playerId ? playerId.slice(0, 8) : 'Session')
  }

  const handleUndo = async (actionId: string) => {
    setPendingActionId(actionId)
    setMessage(null)

    try {
      await devUndoAction(supabase, actionId)
      setMessage('Action undone')
      await onChanged()
    } catch (error) {
      const nextMessage = getErrorMessage(error)
      console.error('Failed to undo judge action:', nextMessage, error)
      setMessage(nextMessage)
    } finally {
      setPendingActionId(null)
    }
  }

  return (
    <section className="leyline-glass-panel rounded-lg p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-300/80">Judge Log</p>
          <h2 className="text-base font-bold text-white">Recent Actions</h2>
        </div>
        <span className="rounded-md border border-white/10 bg-slate-950/60 px-3 py-1 text-xs text-slate-400">
          {actions.length}
        </span>
      </div>

      {actions.length > 0 ? (
        <div className="grid gap-2">
          {actions.map((action) => (
            <div
              key={action.id}
              className={`grid gap-3 rounded-md border p-3 sm:grid-cols-[1fr_auto] sm:items-center ${
                action.undone_at
                  ? 'border-slate-700 bg-slate-950/40 opacity-60'
                  : 'border-white/10 bg-slate-950/60'
              }`}
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-white">
                  {action.description ?? action.action_type}
                </p>
                <p className="text-xs text-slate-500">
                  {getPlayerLabel(action.target_player_id)} - {new Date(action.created_at).toLocaleTimeString()}
                  {action.undone_at ? ' - undone' : ''}
                </p>
              </div>
              <button
                type="button"
                disabled={Boolean(action.undone_at) || pendingActionId === action.id}
                onClick={() => handleUndo(action.id)}
                className="rounded-md border border-amber-300/25 bg-amber-500/10 px-3 py-2 text-sm font-semibold text-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pendingActionId === action.id ? 'Undoing...' : 'Undo'}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-white/10 p-3 text-sm text-slate-500">
          No judge actions logged yet.
        </p>
      )}
      {message ? <p className="mt-3 text-xs text-slate-300">{message}</p> : null}
    </section>
  )
}

function JudgePlayerCardTools({
  sessionId,
  playerId,
  cards,
  isSessionFinished,
  onChanged,
}: {
  sessionId: string
  playerId: string
  cards: ControllerCard[]
  isSessionFinished: boolean
  onChanged: () => Promise<void>
}) {
  const supabase = useMemo(() => createClient(), [])
  const visibleCards = cards.filter((card) => card.zone !== 'library')
  const [selectedCardId, setSelectedCardId] = useState(visibleCards[0]?.id ?? '')
  const [targetZone, setTargetZone] = useState<GameZone>('graveyard')
  const [damageMarked, setDamageMarked] = useState(0)
  const [isPending, setIsPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const selectedCard = visibleCards.find((card) => card.id === selectedCardId) ?? visibleCards[0] ?? null

  useEffect(() => {
    if (selectedCardId && visibleCards.some((card) => card.id === selectedCardId)) {
      return
    }

    setSelectedCardId(visibleCards[0]?.id ?? '')
  }, [selectedCardId, visibleCards])

  useEffect(() => {
    setDamageMarked(selectedCard?.damage_marked ?? 0)
  }, [selectedCard?.id, selectedCard?.damage_marked])

  const runJudgeAction = async (action: () => Promise<unknown>, success: string) => {
    setIsPending(true)
    setMessage(null)

    try {
      await action()
      setMessage(success)
      await onChanged()
    } catch (error) {
      const nextMessage = getErrorMessage(error)
      console.error('Judge card action failed:', nextMessage, error)
      setMessage(nextMessage)
    } finally {
      setIsPending(false)
    }
  }

  return (
    <div className="mt-3 rounded-lg border border-white/10 bg-slate-950/55 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-300">Card Corrections</h3>
        <button
          type="button"
          disabled={isSessionFinished || isPending}
          onClick={() =>
            runJudgeAction(
              () => devShuffleLibrary(supabase, sessionId, playerId),
              'Library shuffled',
            )
          }
          className="rounded-md border border-white/15 bg-slate-800 px-2 py-1 text-xs font-semibold text-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Shuffle Library
        </button>
      </div>

      {visibleCards.length > 0 ? (
        <div className="grid gap-2">
          <select
            value={selectedCard?.id ?? ''}
            onChange={(event) => setSelectedCardId(event.target.value)}
            className="min-w-0 rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white"
          >
            {visibleCards.map((card) => (
              <option key={card.id} value={card.id}>
                {card.name} ({card.zone})
              </option>
            ))}
          </select>

          {selectedCard ? (
            <>
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <select
                  value={targetZone}
                  onChange={(event) => setTargetZone(event.target.value as GameZone)}
                  className="min-w-0 rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white"
                >
                  {gameZones.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={isSessionFinished || isPending}
                  onClick={() =>
                    runJudgeAction(
                      () => devMoveCardToZone(supabase, sessionId, selectedCard.id, targetZone),
                      `Moved to ${targetZone}`,
                    )
                  }
                  className="rounded-md bg-white px-3 py-2 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Move
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={isSessionFinished || isPending}
                  onClick={() =>
                    runJudgeAction(
                      () => devSetCardTapped(supabase, sessionId, selectedCard.id, !selectedCard.is_tapped),
                      selectedCard.is_tapped ? 'Card untapped' : 'Card tapped',
                    )
                  }
                  className="rounded-md border border-white/15 bg-slate-800 px-3 py-2 text-sm font-semibold text-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {selectedCard.is_tapped ? 'Untap' : 'Tap'}
                </button>
                <div className="grid grid-cols-[1fr_auto] gap-2">
                  <input
                    type="number"
                    min={0}
                    value={damageMarked}
                    onChange={(event) => setDamageMarked(Number(event.target.value))}
                    className="min-w-0 rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white"
                  />
                  <button
                    type="button"
                    disabled={isSessionFinished || isPending}
                    onClick={() =>
                      runJudgeAction(
                        () => devSetCardDamage(supabase, sessionId, selectedCard.id, damageMarked),
                        'Damage updated',
                      )
                    }
                    className="rounded-md border border-white/15 bg-slate-800 px-3 py-2 text-sm font-semibold text-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Damage
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={isSessionFinished || isPending}
                  onClick={() =>
                    runJudgeAction(
                      () => devPutCardOnTop(supabase, sessionId, selectedCard.id),
                      'Moved to top of library',
                    )
                  }
                  className="rounded-md border border-cyan-300/20 bg-cyan-950/30 px-3 py-2 text-sm font-semibold text-cyan-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Top Library
                </button>
                <button
                  type="button"
                  disabled={isSessionFinished || isPending}
                  onClick={() =>
                    runJudgeAction(
                      () => devPutCardOnBottom(supabase, sessionId, selectedCard.id),
                      'Moved to bottom of library',
                    )
                  }
                  className="rounded-md border border-cyan-300/20 bg-cyan-950/30 px-3 py-2 text-sm font-semibold text-cyan-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Bottom Library
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-slate-500">No visible cards for this player.</p>
      )}

      {message ? <p className="mt-2 text-xs text-slate-300">{message}</p> : null}
    </div>
  )
}
