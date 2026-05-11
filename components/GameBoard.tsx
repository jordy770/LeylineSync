'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  getBoardCards,
  getCombatAssignments,
  getGameSessionPlayers,
  getStackItems,
  getTurnState,
} from '@/lib/game/data'
import { enableFallbackRefresh } from '@/lib/game/dev'
import type {
  BoardCard,
  CombatAssignment,
  GameSessionPlayer,
  GameTurnState,
  StackItem,
} from '@/lib/game/types'
import type { RealtimePostgresChangesPayload, REALTIME_SUBSCRIBE_STATES } from '@supabase/supabase-js'
import MotionCard from './MotionCard'
import CombatManager from './CombatManager'

type BoardSeat = {
  player: GameSessionPlayer | null
  cards: BoardCard[]
  index: number
  isPriority: boolean
}

type BoardConnection = {
  id: string
  lane: 'combat' | 'stack'
  label: string
  path: string
}

export default function GameBoard({ sessionId }: { sessionId: string }) {
  const [cards, setCards] = useState<BoardCard[]>([])
  const [players, setPlayers] = useState<GameSessionPlayer[]>([])
  const [turnState, setTurnState] = useState<GameTurnState | null>(null)
  const [combatAssignments, setCombatAssignments] = useState<CombatAssignment[]>([])
  const [stackItems, setStackItems] = useState<StackItem[]>([])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [focusedPlayerId, setFocusedPlayerId] = useState<string | null>(null)
  const boardRef = useRef<HTMLDivElement | null>(null)
  const [targetElements, setTargetElements] = useState<Map<string, HTMLElement>>(() => new Map())
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const fetchBoardState = async () => {
      try {
        const [boardCards, sessionPlayers, nextTurnState, nextCombatAssignments, nextStackItems] =
          await Promise.all([
            getBoardCards(supabase, sessionId),
            getGameSessionPlayers(supabase, sessionId),
            getTurnState(supabase, sessionId),
            getCombatAssignments(supabase, sessionId),
            getStackItems(supabase, sessionId),
          ])

        setErrorMessage(null)
        setCards(boardCards)
        setPlayers(sessionPlayers)
        setTurnState(nextTurnState)
        setCombatAssignments(nextCombatAssignments)
        setStackItems(nextStackItems)
      } catch (error) {
        console.error('Failed to fetch board state:', error)
        setErrorMessage(error instanceof Error ? error.message : 'Could not load board state')
      }
    }

    fetchBoardState()

    const channel = supabase
      .channel(`board:${sessionId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_cards',
          filter: `session_id=eq.${sessionId}`,
        },
        (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
          console.log('Board received realtime update:', payload)
          fetchBoardState()
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'cards',
        },
        fetchBoardState,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_turn_state',
          filter: `session_id=eq.${sessionId}`,
        },
        fetchBoardState,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_session_players',
          filter: `session_id=eq.${sessionId}`,
        },
        fetchBoardState,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_combat_assignments',
          filter: `session_id=eq.${sessionId}`,
        },
        fetchBoardState,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_combat_blockers',
          filter: `session_id=eq.${sessionId}`,
        },
        fetchBoardState,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_stack_items',
          filter: `session_id=eq.${sessionId}`,
        },
        fetchBoardState,
      )
      .subscribe((status: `${REALTIME_SUBSCRIBE_STATES}`, error?: Error) => {
        console.log('Board realtime status:', status)
        if (error) {
          console.error('Board realtime error:', error)
        }
      })

    const refreshInterval = enableFallbackRefresh ? window.setInterval(fetchBoardState, 2000) : null

    return () => {
      if (refreshInterval) {
        window.clearInterval(refreshInterval)
      }
      supabase.removeChannel(channel)
    }
  }, [sessionId, supabase])

  const combatCardIds = useMemo(() => getCombatCardIds(combatAssignments), [combatAssignments])
  const boardCards = useMemo(
    () => cards.filter((card) => !combatCardIds.has(card.id)),
    [cards, combatCardIds],
  )
  const seats = useMemo(
    () => buildBoardSeats(players, boardCards, turnState?.priority_player_id ?? null),
    [boardCards, players, turnState?.priority_player_id],
  )
  const connections = useMemo(
    () => buildBoardConnections(combatAssignments, stackItems),
    [combatAssignments, stackItems],
  )
  const focusSeat = getFocusSeat(seats, focusedPlayerId)
  const minimapSeats = seats.filter((seat) => seat.player && seat.player.player_id !== focusSeat.player?.player_id)
  const pendingStackItems = stackItems.filter((item) => item.status === 'pending')
  const registerTargetRef = useCallback((playerId: string, element: HTMLElement | null) => {
    if (!playerId) {
      return
    }

    setTargetElements((current) => {
      const currentElement = current.get(playerId) ?? null
      if (currentElement === element) {
        return current
      }

      const next = new Map(current)
      if (element) {
        next.set(playerId, element)
      } else {
        next.delete(playerId)
      }

      return next
    })
  }, [])

  if (errorMessage) {
    return (
      <div className="p-6">
        <div className="rounded-lg bg-red-950 p-4 text-sm text-red-100">
          Could not load board cards: {errorMessage}
        </div>
      </div>
    )
  }

  return (
    <div ref={boardRef} className="relative isolate min-h-[calc(100vh-4rem)] overflow-hidden p-4 [perspective:1600px] sm:p-6">
      <div className="pointer-events-none absolute inset-0 opacity-40">
        <div
          className="absolute inset-0 opacity-10"
          style={{
            backgroundImage: 'radial-gradient(circle at 2px 2px, white 1px, transparent 0)',
            backgroundSize: '40px 40px',
          }}
        />
        <div className="absolute inset-x-8 top-1/2 h-px bg-cyan-200/20 [transform:rotateX(62deg)_translateZ(-70px)]" />
        <div className="absolute bottom-0 left-10 right-10 top-28 bg-[linear-gradient(90deg,transparent,rgba(103,232,249,0.12),transparent)] blur-2xl [transform:rotateX(66deg)_translateZ(-100px)]" />
        <div className="absolute bottom-12 left-16 right-16 h-px bg-cyan-200/10 [transform:rotateX(66deg)_translateZ(-90px)]" />
        <div className="absolute bottom-32 left-24 right-24 h-px bg-cyan-200/10 [transform:rotateX(66deg)_translateZ(-90px)]" />
        <div className="absolute -left-20 bottom-0 h-72 w-72 rounded-full bg-cyan-500/10 blur-3xl" />
        <div className="absolute -right-16 top-0 h-60 w-60 rounded-full bg-red-500/10 blur-3xl" />
      </div>
      <BoardConnectionOverlay connections={connections} />
      <BoardViewChrome
        turnState={turnState}
        isFocusMode={Boolean(focusedPlayerId)}
        onToggleFocus={() => setFocusedPlayerId((current) => (current ? null : focusSeat.player?.player_id ?? null))}
      />
      <AnimatePresence mode="wait">
        {focusedPlayerId ? (
          <motion.div
            key="focus-board"
            layout
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            className="relative z-20 grid min-h-[72vh] gap-5 [transform-style:preserve-3d] xl:grid-cols-[minmax(0,1fr)_10.5rem_minmax(16rem,20rem)] 2xl:gap-8 2xl:grid-cols-[minmax(0,1fr)_11rem_minmax(18rem,22rem)]"
          >
            <FocusSeatPanel seat={focusSeat} turnState={turnState} />
            <StackRail stackItems={pendingStackItems} />
            <motion.aside layout className="grid content-start gap-3">
              <AnimatePresence initial={false}>
                {minimapSeats.map((seat) => (
                  <MiniPlayerWidget
                    key={seat.player?.player_id ?? seat.index}
                    seat={seat}
                    registerTargetRef={registerTargetRef}
                    onClick={() => setFocusedPlayerId(seat.player?.player_id ?? null)}
                  />
                ))}
              </AnimatePresence>
            </motion.aside>
          </motion.div>
        ) : (
          <motion.div
            key="grid-board"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="relative z-20 grid min-h-[72vh] gap-4 xl:grid-cols-[minmax(0,1fr)_10.5rem] 2xl:gap-6"
          >
            <div className="grid min-h-[72vh] grid-cols-1 gap-4 md:grid-cols-2">
              {seats.length > 0 ? (
                seats.map((seat) => (
                  <PlayerQuadrantPanel
                    key={seat.player?.player_id ?? seat.index}
                    seat={seat}
                    turnState={turnState}
                    onFocus={() => setFocusedPlayerId(seat.player?.player_id ?? null)}
                  />
                ))
              ) : (
                <EmptyBoardPanel />
              )}
            </div>
            <StackRail stackItems={pendingStackItems} />
          </motion.div>
        )}
      </AnimatePresence>
      <CombatManager
        assignments={combatAssignments}
        cards={cards}
        boardElement={boardRef.current}
        targetElements={targetElements}
      />
    </div>
  )
}

function BoardViewChrome({
  turnState,
  isFocusMode,
  onToggleFocus,
}: {
  turnState: GameTurnState | null
  isFocusMode: boolean
  onToggleFocus: () => void
}) {
  return (
    <div className="relative z-30 mb-4 flex flex-wrap items-center justify-between gap-3">
      <div className="rounded-full border border-slate-700 bg-slate-900/80 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-black/30 backdrop-blur">
        Turn {turnState?.turn_number ?? '-'} · {formatStepLabel(turnState?.step)}
      </div>
      <button
        type="button"
        onClick={onToggleFocus}
        className="rounded-lg border border-slate-700 bg-slate-900/85 px-4 py-2 text-sm font-semibold text-slate-200 transition-colors hover:bg-slate-800"
      >
        {isFocusMode ? 'Grid View' : 'Focus Priority'}
      </button>
    </div>
  )
}

function FocusSeatPanel({
  seat,
  turnState,
}: {
  seat: BoardSeat
  turnState: GameTurnState | null
}) {
  return (
    <motion.section
      layout
      className="relative z-10 min-h-[32rem] overflow-hidden rounded-lg border border-cyan-300/70 bg-slate-950/65 p-4 shadow-[0_30px_70px_rgba(0,0,0,0.5),0_0_34px_rgba(56,189,248,0.32)] [transform:rotateX(5deg)_translateZ(0)] [transform-origin:center_bottom] [transform-style:preserve-3d]"
    >
      <div className="absolute inset-0 rounded-lg border border-cyan-300/30" />
      <div className="pointer-events-none absolute inset-x-8 top-0 h-px bg-cyan-200/80 shadow-[0_0_18px_rgba(125,211,252,0.9)]" />
      <div className="pointer-events-none absolute inset-x-6 bottom-6 top-20 rounded-[1.5rem] border border-cyan-200/10 bg-[linear-gradient(115deg,rgba(14,165,233,0.08),transparent_42%,rgba(148,163,184,0.06))]" />
      <div className="relative mb-4 flex flex-wrap items-start justify-between gap-3 [transform:translateZ(28px)]">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-200">
            {seat.player ? `Player ${seat.player.seat_number}` : 'No active player'}
          </p>
          <h2 className="truncate text-lg font-bold text-white">
            {seat.player ? getPlayerLabel(seat.player) : 'Waiting for players'}
            {seat.isPriority ? <span className="text-cyan-300"> - Priority</span> : null}
          </h2>
        </div>
        <div className="rounded border border-cyan-300/50 bg-cyan-950/50 px-3 py-2 text-right">
          <p className="text-[10px] uppercase text-cyan-200/80">Phase</p>
          <p className="text-sm font-bold text-white">{formatStepLabel(turnState?.step)}</p>
        </div>
      </div>
      <motion.div
        layout
        className="relative grid grid-cols-2 gap-3 [transform:translateZ(34px)] sm:grid-cols-3 xl:grid-cols-5"
      >
        <AnimatePresence initial={false}>
          {seat.cards.map((card) => (
            <MotionCard
              key={card.id}
              card={{
                id: card.id,
                name: card.name,
                image_url: card.image_url,
                is_tapped: card.is_tapped,
                damage_marked: card.damage_marked,
                zone: card.zone,
              }}
              size="board"
              className="max-w-40 shadow-[0_16px_26px_rgba(0,0,0,0.42)] [transform:translateZ(14px)]"
            />
          ))}
        </AnimatePresence>
      </motion.div>
      {seat.cards.length === 0 ? (
        <div className="relative flex min-h-56 items-center justify-center rounded-md border border-dashed border-cyan-300/20 text-xs text-cyan-100/40 [transform:translateZ(20px)]">
          Battlefield empty
        </div>
      ) : null}
    </motion.section>
  )
}

function MiniPlayerWidget({
  seat,
  registerTargetRef,
  onClick,
}: {
  seat: BoardSeat
  registerTargetRef: (playerId: string, element: HTMLElement | null) => void
  onClick?: () => void
}) {
  if (!seat.player) {
    return null
  }

  return (
    <motion.section
      ref={(element) => registerTargetRef(seat.player?.player_id ?? '', element)}
      role="button"
      tabIndex={0}
      layout
      initial={{ opacity: 0, x: 18 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 18 }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onClick?.()
        }
      }}
      className="relative z-40 cursor-pointer rounded-lg border border-white/10 bg-slate-950/85 p-3 shadow-[0_22px_50px_rgba(0,0,0,0.45)] backdrop-blur transition-colors hover:border-cyan-300/50 [transform:translateZ(36px)]"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
            P{seat.player.seat_number}
          </p>
          <p className="truncate text-sm font-bold text-white">{getPlayerLabel(seat.player)}</p>
        </div>
        <p className={seat.isPriority ? 'text-3xl font-bold text-cyan-300' : 'text-3xl font-bold text-red-300'}>
          {seat.player.life_total}
        </p>
      </div>
      <div className="mb-3 grid grid-cols-2 gap-2 text-xs text-slate-400">
        <div>
          <p className="text-slate-500">Battlefield</p>
          <p className="font-semibold text-white">{seat.cards.length}</p>
        </div>
        <div>
          <p className="text-slate-500">Seat</p>
          <p className="font-semibold text-white">{seat.player.seat_number}</p>
        </div>
      </div>
      <motion.div layout className="flex gap-1 overflow-hidden">
        {seat.cards.slice(0, 4).map((card) => (
          <MotionCard
            key={card.id}
            card={{
              id: card.id,
              name: card.name,
              image_url: card.image_url,
              is_tapped: card.is_tapped,
              damage_marked: card.damage_marked,
              zone: card.zone,
            }}
            size="thumb"
            className="-mr-5 border-cyan-200/20"
          />
        ))}
      </motion.div>
    </motion.section>
  )
}

function PlayerQuadrantPanel({
  seat,
  turnState,
  onFocus,
}: {
  seat: BoardSeat
  turnState: GameTurnState | null
  onFocus: () => void
}) {
  if (!seat.player) {
    return null
  }

  return (
    <motion.section
      layout
      role="button"
      tabIndex={0}
      onClick={onFocus}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onFocus()
        }
      }}
      className={`group relative min-h-[20rem] cursor-pointer overflow-hidden rounded-lg border bg-gradient-to-br p-3 shadow-[0_24px_60px_rgba(0,0,0,0.42)] transition-colors ${
        seat.isPriority
          ? 'border-amber-300/80 from-amber-950/55 to-slate-950/90 mtg-priority-border'
          : 'border-white/10 from-slate-900/85 to-slate-950/95 hover:border-cyan-300/45'
      }`}
      whileHover={{ scale: 1.01 }}
      whileTap={{ scale: 0.99 }}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(34,211,238,0.16),transparent_34%),radial-gradient(circle_at_100%_100%,rgba(245,158,11,0.12),transparent_32%)]" />
      {seat.isPriority ? (
        <motion.div
          className="pointer-events-none absolute inset-0 rounded-lg border-4 border-amber-400"
          animate={{ opacity: [0.45, 1, 0.45] }}
          transition={{ repeat: Infinity, duration: 1.5 }}
        />
      ) : null}
      <div className="relative z-10 mb-3 flex items-center justify-between gap-3 border-b border-white/10 pb-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-slate-600 to-slate-900 text-base font-bold text-white">
            {getPlayerInitial(seat.player)}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-white">{getPlayerLabel(seat.player)}</p>
            <p className="text-xs text-slate-400">
              P{seat.player.seat_number} · {formatStepLabel(turnState?.step)}
            </p>
          </div>
        </div>
        <div className="text-right">
          <p
            className={`text-3xl font-bold ${
              seat.player.life_total > 20
                ? 'text-emerald-300'
                : seat.player.life_total > 10
                  ? 'text-amber-300'
                  : 'text-red-300'
            }`}
          >
            {seat.player.life_total}
          </p>
          <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Life</p>
        </div>
      </div>
      <div className="relative z-10">
        <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
          <span>Battlefield</span>
          <span>{seat.cards.length} cards</span>
        </div>
        {seat.cards.length > 0 ? (
          <motion.div layout className="grid grid-cols-3 gap-2 sm:grid-cols-4 2xl:grid-cols-5">
            <AnimatePresence initial={false}>
              {seat.cards.slice(0, 10).map((card) => (
                <MotionCard
                  key={card.id}
                  card={{
                    id: card.id,
                    name: card.name,
                    image_url: card.image_url,
                    is_tapped: card.is_tapped,
                    damage_marked: card.damage_marked,
                    zone: card.zone,
                  }}
                  size="board"
                  className={`shadow-[0_12px_24px_rgba(0,0,0,0.42)] ${
                    seat.isPriority ? 'ring-1 ring-amber-300/25' : ''
                  }`}
                />
              ))}
            </AnimatePresence>
          </motion.div>
        ) : (
          <div className="flex min-h-44 items-center justify-center rounded-lg border border-dashed border-white/10 text-xs text-slate-500">
            Battlefield empty
          </div>
        )}
      </div>
    </motion.section>
  )
}

function EmptyBoardPanel() {
  return (
    <div className="col-span-full flex min-h-[24rem] items-center justify-center rounded-lg border border-dashed border-cyan-300/20 bg-slate-950/50 text-sm text-slate-500">
      Waiting for players to join the session.
    </div>
  )
}

function StackRail({ stackItems }: { stackItems: StackItem[] }) {
  return (
    <motion.section
      layout
      className="relative z-30 order-first mx-auto w-full max-w-44 rounded-lg border border-cyan-200/40 bg-black/85 p-3 text-center shadow-[0_24px_54px_rgba(0,0,0,0.52),0_0_22px_rgba(34,211,238,0.2)] [transform:translateZ(42px)] xl:order-none"
    >
      <h2 className="mb-3 rounded border border-cyan-300/40 bg-cyan-950/40 py-1 text-xs font-bold uppercase tracking-[0.18em] text-white">
        The Stack
      </h2>
      <div className="grid gap-2 lg:min-h-[26rem] lg:content-start">
        {stackItems.length === 0 ? (
          <div className="rounded border border-white/10 px-2 py-12 text-xs text-slate-500 lg:py-24">
            Empty
          </div>
        ) : (
          stackItems.map((item) => (
            <motion.div
              key={item.id}
              layout
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="rounded border border-cyan-300/40 bg-cyan-950/30 p-2 text-left shadow-[0_0_14px_rgba(34,211,238,0.12)]"
            >
              <p className="truncate text-xs font-semibold text-white">
                {item.source_card_name ?? item.action_type}
              </p>
              <p className="truncate text-[10px] text-cyan-200/70">{item.controller_username ?? 'Unknown'}</p>
            </motion.div>
          ))
        )}
      </div>
    </motion.section>
  )
}

function buildBoardSeats(
  players: GameSessionPlayer[],
  cards: BoardCard[],
  priorityPlayerId: string | null,
) {
  const sortedPlayers = [...players].sort((left, right) => left.seat_number - right.seat_number)

  return sortedPlayers.map<BoardSeat>((player, index) => ({
    player,
    index,
    isPriority: Boolean(player && player.player_id === priorityPlayerId),
    cards: cards.filter((card) => card.controller_player_id === player.player_id),
  }))
}

function getCombatCardIds(assignments: CombatAssignment[]) {
  const cardIds = new Set<string>()

  for (const assignment of assignments) {
    cardIds.add(assignment.attacker_card_id)
    for (const blocker of assignment.blockers ?? []) {
      cardIds.add(blocker.blocker_card_id)
    }
  }

  return cardIds
}

function getPlayerLabel(player: GameSessionPlayer) {
  return player.username || `Player ${player.player_id.slice(0, 8)}`
}

function getFocusSeat(seats: BoardSeat[], focusedPlayerId?: string | null) {
  return (
    (focusedPlayerId ? seats.find((seat) => seat.player?.player_id === focusedPlayerId) : null) ??
    seats.find((seat) => seat.isPriority) ??
    seats[0] ?? {
      player: null,
      cards: [],
      index: 0,
      isPriority: false,
    }
  )
}

function formatStepLabel(step: GameTurnState['step'] | undefined) {
  if (!step) {
    return '-'
  }

  return step
    .split('_')
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ')
}

function getPlayerInitial(player: GameSessionPlayer) {
  return (player.username?.trim()[0] || `P${player.seat_number}`[0] || 'P').toUpperCase()
}

function buildBoardConnections(
  combatAssignments: CombatAssignment[],
  stackItems: StackItem[],
): BoardConnection[] {
  const combatConnections = combatAssignments.slice(0, 5).map((assignment, index) => ({
    id: `combat-${assignment.id}`,
    lane: 'combat' as const,
    label: assignment.blocker_name
      ? `${assignment.attacker_name} blocked by ${assignment.blocker_name}`
      : `${assignment.attacker_name} attacks ${assignment.defending_username}`,
    path: connectionPath(index, combatAssignments.length, 18, 82),
  }))

  const stackConnections = stackItems
    .filter((item) => item.status === 'pending')
    .slice(0, 3)
    .map((item, index) => ({
      id: `stack-${item.id}`,
      lane: 'stack' as const,
      label: item.source_card_name ?? item.action_type,
      path: connectionPath(index, 3, 82, 18),
    }))

  return [...combatConnections, ...stackConnections]
}

function connectionPath(index: number, total: number, startY: number, endY: number) {
  const spread = total <= 1 ? 0 : (index - (total - 1) / 2) * 10
  const startX = 18 + Math.max(0, index) * 5
  const endX = 82 - Math.max(0, index) * 5
  const controlX = 50 + spread

  return `M ${startX} ${startY} C ${controlX} ${startY}, ${controlX} ${endY}, ${endX} ${endY}`
}

function BoardConnectionOverlay({ connections }: { connections: BoardConnection[] }) {
  if (connections.length === 0) {
    return null
  }

  return (
    <svg
      className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <AnimatePresence>
        {connections.map((connection) => (
          <motion.path
            key={connection.id}
            d={connection.path}
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 0.85 }}
            exit={{ pathLength: 0, opacity: 0 }}
            transition={{ duration: 0.55, ease: 'easeOut' }}
            fill="none"
            stroke={connection.lane === 'combat' ? '#f59e0b' : '#38bdf8'}
            strokeLinecap="round"
            strokeWidth="0.45"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </AnimatePresence>
    </svg>
  )
}
