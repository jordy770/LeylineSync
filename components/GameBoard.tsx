'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useMemo, useRef, useState } from 'react'
import {
  buildBoardConnections,
  buildBoardSeats,
  getCombatCardIds,
  getFocusSeat,
  type BoardSeat,
} from '@/lib/game/board-selectors'
import { useBoardGameState } from '@/lib/game/use-board-game-state'
import type {
  GameSessionPlayer,
  GameTurnState,
} from '@/lib/game/types'
import BoardConnectionOverlay from './board/BoardConnectionOverlay'
import BoardViewChrome from './board/BoardViewChrome'
import EmptyBoardPanel from './board/EmptyBoardPanel'
import StackRail from './board/StackRail'
import MotionCard from './MotionCard'
import CombatManager from './CombatManager'

export default function GameBoard({ sessionId }: { sessionId: string }) {
  const { cards, players, turnState, combatAssignments, stackItems, errorMessage } = useBoardGameState(sessionId)
  const [focusedPlayerId, setFocusedPlayerId] = useState<string | null>(null)
  const boardRef = useRef<HTMLDivElement | null>(null)
  const [targetElements, setTargetElements] = useState<Map<string, HTMLElement>>(() => new Map())

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
    <div ref={boardRef} className="relative isolate min-h-[calc(100vh-5.75rem)] overflow-hidden p-4 [perspective:1600px] [@media(max-height:640px)]:min-h-[calc(100svh-4.5rem)] [@media(max-height:640px)]:p-2 sm:p-6">
      <div className="pointer-events-none absolute inset-0 opacity-40">
        <div className="leyline-table-grid absolute inset-0 opacity-10" />
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
            className="relative z-20 grid min-h-[72vh] gap-5 [transform-style:preserve-3d] [@media(max-height:640px)]:min-h-[calc(100svh-8rem)] [@media(max-height:640px)]:grid-cols-[minmax(0,1fr)_7.5rem_minmax(9rem,11rem)] [@media(max-height:640px)]:gap-2 xl:grid-cols-[minmax(0,1fr)_10.5rem_minmax(16rem,20rem)] 2xl:gap-8 2xl:grid-cols-[minmax(0,1fr)_11rem_minmax(18rem,22rem)]"
          >
            <FocusSeatPanel seat={focusSeat} turnState={turnState} />
            <StackRail stackItems={pendingStackItems} />
            <motion.aside layout className="grid content-start gap-3 [@media(max-height:640px)]:gap-2">
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
            className="relative z-20 grid min-h-[72vh] gap-4 [@media(max-height:640px)]:min-h-[calc(100svh-8rem)] [@media(max-height:640px)]:grid-cols-[minmax(0,1fr)_7.5rem] [@media(max-height:640px)]:gap-2 xl:grid-cols-[minmax(0,1fr)_10.5rem] 2xl:gap-6"
          >
            <div className="grid min-h-[72vh] grid-cols-1 gap-4 [@media(max-height:640px)]:min-h-[calc(100svh-8rem)] [@media(max-height:640px)]:grid-cols-2 [@media(max-height:640px)]:gap-2 md:grid-cols-2">
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
      className={`leyline-glass-panel relative z-10 min-h-[32rem] overflow-hidden rounded-lg p-4 [transform:rotateX(5deg)_translateZ(0)] [transform-origin:center_bottom] [transform-style:preserve-3d] [@media(max-height:640px)]:min-h-[calc(100svh-8rem)] [@media(max-height:640px)]:p-3 ${
        seat.isPriority ? 'leyline-priority-panel mtg-priority-border' : ''
      }`}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_16%_0%,rgba(34,211,238,0.12),transparent_26%),linear-gradient(115deg,rgba(148,163,184,0.08),transparent_40%)]" />
      <div className="pointer-events-none absolute inset-x-8 top-0 h-px bg-cyan-200/55 shadow-[0_0_18px_rgba(125,211,252,0.55)]" />
      <div className="pointer-events-none absolute inset-x-6 bottom-6 top-20 rounded-lg border border-white/10" />
      <div className="relative mb-4 flex flex-wrap items-start justify-between gap-3 [transform:translateZ(28px)] [@media(max-height:640px)]:mb-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-200/85">
            {seat.player ? `Player ${seat.player.seat_number}` : 'No active player'}
          </p>
          <h2 className="truncate text-lg font-bold text-white">
            {seat.player ? getPlayerLabel(seat.player) : 'Waiting for players'}
            {seat.isPriority ? <span className="text-cyan-300"> - Priority</span> : null}
          </h2>
        </div>
        <div className="rounded-md border border-white/15 bg-slate-950/70 px-3 py-2 text-right">
          <p className="text-[10px] uppercase text-cyan-200/80">Phase</p>
          <p className="text-sm font-bold text-white">{formatStepLabel(turnState?.step)}</p>
        </div>
      </div>
      <motion.div
        layout
        className="relative grid grid-cols-2 gap-3 [transform:translateZ(34px)] [@media(max-height:640px)]:grid-cols-4 [@media(max-height:640px)]:gap-2 sm:grid-cols-3 xl:grid-cols-5"
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
              className="max-w-40 [transform:translateZ(14px)] [@media(max-height:640px)]:max-w-20"
              visualClassName="shadow-[0_16px_26px_rgba(0,0,0,0.42)]"
            />
          ))}
        </AnimatePresence>
      </motion.div>
      {seat.cards.length === 0 ? (
        <div className="relative flex min-h-56 items-center justify-center rounded-md border border-dashed border-white/15 text-xs text-slate-500 [transform:translateZ(20px)] [@media(max-height:640px)]:min-h-28">
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
      className={`leyline-glass-panel relative z-40 cursor-pointer rounded-lg p-3 transition-colors hover:border-cyan-300/50 [transform:translateZ(36px)] [@media(max-height:640px)]:p-2 ${
        seat.isPriority ? 'leyline-priority-panel' : ''
      }`}
    >
      <div className="mb-3 flex items-start justify-between gap-3 [@media(max-height:640px)]:mb-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
            P{seat.player.seat_number}
          </p>
          <p className="truncate text-sm font-bold text-white">{getPlayerLabel(seat.player)}</p>
        </div>
        <p className={seat.isPriority ? 'text-3xl font-bold text-amber-300 [@media(max-height:640px)]:text-xl' : 'text-3xl font-bold text-cyan-200 [@media(max-height:640px)]:text-xl'}>
          {seat.player.life_total}
        </p>
      </div>
      <div className="mb-3 grid grid-cols-2 gap-2 text-xs text-slate-400 [@media(max-height:640px)]:hidden">
        <div>
          <p className="text-slate-500">Battlefield</p>
          <p className="font-semibold text-white">{seat.cards.length}</p>
        </div>
        <div>
          <p className="text-slate-500">Seat</p>
          <p className="font-semibold text-white">{seat.player.seat_number}</p>
        </div>
      </div>
      <motion.div layout className="flex gap-1 overflow-hidden [@media(max-height:640px)]:hidden">
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
            className="-mr-5"
            visualClassName="border-cyan-200/20"
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
      className={`leyline-glass-panel group relative min-h-[20rem] cursor-pointer overflow-hidden rounded-lg p-3 transition-colors [@media(max-height:640px)]:min-h-[10.5rem] [@media(max-height:640px)]:p-2 ${
        seat.isPriority
          ? 'leyline-priority-panel mtg-priority-border'
          : 'hover:border-cyan-300/45'
      }`}
      whileHover={{ scale: 1.01 }}
      whileTap={{ scale: 0.99 }}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(34,211,238,0.12),transparent_34%),radial-gradient(circle_at_100%_100%,rgba(245,158,11,0.08),transparent_32%)]" />
      {seat.isPriority ? (
        <motion.div
          className="pointer-events-none absolute inset-0 rounded-lg border-2 border-amber-300"
          animate={{ opacity: [0.45, 1, 0.45] }}
          transition={{ repeat: Infinity, duration: 1.5 }}
        />
      ) : null}
      <div className="relative z-10 mb-3 flex items-center justify-between gap-3 border-b border-white/10 pb-3 [@media(max-height:640px)]:mb-2 [@media(max-height:640px)]:gap-2 [@media(max-height:640px)]:pb-2">
        <div className="flex min-w-0 items-center gap-3">
          <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border text-base font-bold text-white [@media(max-height:640px)]:h-8 [@media(max-height:640px)]:w-8 [@media(max-height:640px)]:text-sm ${
            seat.isPriority ? 'border-amber-300/50 bg-amber-500/15' : 'border-cyan-200/20 bg-slate-900/80'
          }`}>
            {getPlayerInitial(seat.player)}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-white [@media(max-height:640px)]:text-xs">{getPlayerLabel(seat.player)}</p>
            <p className="text-xs text-slate-400 [@media(max-height:640px)]:text-[10px]">
              P{seat.player.seat_number} &middot; {formatStepLabel(turnState?.step)}
            </p>
          </div>
        </div>
        <div className="text-right">
          <p
            className={`text-3xl font-bold [@media(max-height:640px)]:text-xl ${
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
        <div className="mb-2 flex items-center justify-between text-xs text-slate-500 [@media(max-height:640px)]:mb-1 [@media(max-height:640px)]:text-[10px]">
          <span>Battlefield</span>
          <span>{seat.cards.length} cards</span>
        </div>
        {seat.cards.length > 0 ? (
          <motion.div layout className="grid grid-cols-3 gap-2 [@media(max-height:640px)]:grid-cols-4 [@media(max-height:640px)]:gap-1 sm:grid-cols-4 2xl:grid-cols-5">
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
                  className="[@media(max-height:640px)]:max-w-14"
                  visualClassName={`shadow-[0_12px_24px_rgba(0,0,0,0.42)] ${
                    seat.isPriority ? 'ring-1 ring-amber-300/25' : ''
                  }`}
                />
              ))}
            </AnimatePresence>
          </motion.div>
        ) : (
          <div className="flex min-h-44 items-center justify-center rounded-lg border border-dashed border-white/10 text-xs text-slate-500 [@media(max-height:640px)]:min-h-16">
            Battlefield empty
          </div>
        )}
      </div>
    </motion.section>
  )
}

function getPlayerLabel(player: GameSessionPlayer) {
  return player.username || `Player ${player.player_id.slice(0, 8)}`
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

