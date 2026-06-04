'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { Bell, Eye, Hand, Layers, Swords, X, Zap } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Badge, EmptyPanel, MiniManaPool, StatPill } from './controller/ControllerAtoms'
import { castCardFromHand, getErrorMessage, passPriority, putCounterSpellOnStack } from '@/lib/game/actions'
import {
  doesCardRequireStackTarget,
  getCanQuickCast,
  getPowerToughnessLabel,
  isLandCard,
  selectControllerViewModel,
} from '@/lib/game/controller-selectors'
import { useControllerGameState } from '@/lib/game/use-controller-game-state'
import type {
  BoardCard,
  CombatAssignment,
  ControllerCard,
  GameSessionPlayer,
  GameTurnState,
  ManaPool,
  StackItem,
} from '@/lib/game/types'
import ActionButtons from './ActionButtons'
import CardZoneControls from './CardZoneControls'
import MotionCard from './MotionCard'

type ControllerTab = 'hand' | 'board' | 'opponents' | 'stack'

export default function ControllerListV2({ sessionId }: { sessionId: string }) {
  const {
    supabase,
    cards,
    boardCards,
    players,
    turnState,
    combatActionState,
    combatAssignments,
    stackItems,
    manaPool,
    playerId,
    isSessionFinished,
    isLoading,
    errorMessage,
    setErrorMessage,
    setTurnState,
  } = useControllerGameState(sessionId)
  const [activeTab, setActiveTab] = useState<ControllerTab>('hand')
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null)
  const [inspectedBoardCard, setInspectedBoardCard] = useState<BoardCard | null>(null)
  const [selectedStackTargetId, setSelectedStackTargetId] = useState<string | null>(null)
  const [isPassingPriority, setIsPassingPriority] = useState(false)
  const [isCastingTargetedSpell, setIsCastingTargetedSpell] = useState(false)

  const {
    handCards,
    battlefieldCards,
    graveyardCount,
    libraryCount,
    pendingStackItems,
    currentPlayer,
    opponentPlayers,
    selectedCard,
    canUseInstantActions,
    canUseSorceryActions,
    responseCards,
    stackTargetCard,
  } = useMemo(
    () =>
      selectControllerViewModel({
        cards,
        players,
        playerId,
        combatActionState,
        isSessionFinished,
        stackItems,
        selectedCardId,
        selectedStackTargetId,
      }),
    [cards, combatActionState, isSessionFinished, playerId, players, selectedCardId, selectedStackTargetId, stackItems],
  )

  const handlePassPriority = async () => {
    setErrorMessage(null)
    setIsPassingPriority(true)

    try {
      const nextTurnState = await passPriority(supabase, sessionId)
      setTurnState(nextTurnState)
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to pass priority:', message, error)
      setErrorMessage(message)
    } finally {
      setIsPassingPriority(false)
    }
  }

  const handleCastTargetedSpell = async () => {
    if (!selectedCard || !stackTargetCard) {
      return
    }

    setErrorMessage(null)
    setIsCastingTargetedSpell(true)

    try {
      await putCounterSpellOnStack(supabase, sessionId, stackTargetCard.id, selectedCard.id)
      setSelectedStackTargetId(null)
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to cast targeted spell:', message, error)
      setErrorMessage(message)
    } finally {
      setIsCastingTargetedSpell(false)
    }
  }

  const handleQuickCast = async (card: ControllerCard) => {
    setErrorMessage(null)

    if (doesCardRequireStackTarget(card)) {
      setSelectedCardId(card.id)
      setActiveTab('stack')
      setSelectedStackTargetId(pendingStackItems[0]?.id ?? null)
      return
    }

    try {
      await castCardFromHand(supabase, sessionId, card.id)
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to cast card:', message, error)
      setErrorMessage(message)
    }
  }

  if (isLoading) {
    return (
      <div className="flex min-h-[100svh] items-center justify-center px-4 pt-10 text-sm text-slate-400">
        Loading controller...
      </div>
    )
  }

  if (errorMessage && cards.length === 0) {
    return (
      <div className="px-4 pt-14">
        <div className="rounded-lg border border-red-400/20 bg-red-950/70 p-4 text-sm text-red-100">
          Could not load controller v2: {errorMessage}
        </div>
      </div>
    )
  }

  return (
    <div className="relative min-h-[100svh] overflow-hidden px-3 pb-24 pt-11 text-white">
      <div className="pointer-events-none absolute inset-0 opacity-55">
        <div className="leyline-table-grid absolute inset-0 opacity-10" />
        <div className="absolute inset-x-10 top-20 h-px bg-cyan-200/20" />
        <div className="absolute -bottom-24 left-1/2 h-72 w-[42rem] -translate-x-1/2 rounded-[100%] bg-cyan-500/10 blur-3xl" />
      </div>

      <div className="relative z-10 mx-auto flex min-h-[calc(100svh-8.5rem)] w-full max-w-md flex-col gap-2.5 landscape:max-w-5xl">
        <ControllerStatusHeader
          currentPlayer={currentPlayer}
          turnState={turnState}
          manaPool={manaPool}
          isPriority={canUseInstantActions}
          isSessionFinished={isSessionFinished}
        />

        <PriorityInbox
          isVisible={canUseInstantActions}
          pendingStackItems={pendingStackItems}
          combatAssignments={combatAssignments}
          responseCards={responseCards}
          selectedCardId={selectedCard?.id}
          isPassingPriority={isPassingPriority}
          onSelectCard={(cardId) => {
            setSelectedCardId(cardId)
            setActiveTab('hand')
          }}
          onPassPriority={handlePassPriority}
        />

        <ControllerTabs
          activeTab={activeTab}
          handCount={handCards.length}
          boardCount={battlefieldCards.length}
          opponentCount={opponentPlayers.length}
          stackCount={pendingStackItems.length}
          onChange={setActiveTab}
        />

        <main className="min-h-0 flex-1">
          <AnimatePresence mode="wait" initial={false}>
            {activeTab === 'hand' ? (
              <motion.div key="hand" initial={{ opacity: 0, x: -14 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 14 }}>
                <HandView
                  cards={handCards}
                  selectedCardId={selectedCardId ?? undefined}
                  canUseSorceryActions={canUseSorceryActions}
                  canUseInstantActions={canUseInstantActions}
                  pendingStackCount={pendingStackItems.length}
                  onSelectCard={setSelectedCardId}
                  onQuickCast={handleQuickCast}
                />
              </motion.div>
            ) : null}

            {activeTab === 'board' ? (
              <motion.div key="board" initial={{ opacity: 0, x: 14 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -14 }}>
                <MyBoardView cards={battlefieldCards} selectedCardId={selectedCardId ?? undefined} onSelectCard={setSelectedCardId} />
              </motion.div>
            ) : null}

            {activeTab === 'opponents' ? (
              <motion.div key="opponents" initial={{ opacity: 0, x: 14 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -14 }}>
                <OpponentBattlefieldCarousel
                  players={opponentPlayers}
                  boardCards={boardCards}
                  onInspectCard={setInspectedBoardCard}
                />
              </motion.div>
            ) : null}

            {activeTab === 'stack' ? (
              <motion.div key="stack" initial={{ opacity: 0, x: 14 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -14 }}>
                <StackView
                  items={pendingStackItems}
                  selectedTargetId={selectedStackTargetId}
                  onSelectTarget={setSelectedStackTargetId}
                />
              </motion.div>
            ) : null}
          </AnimatePresence>
        </main>
      </div>

      <SelectedCardSheet
        card={selectedCard}
        playerId={playerId}
        sessionId={sessionId}
        isSessionFinished={isSessionFinished}
        sessionPlayers={players}
        stackItems={stackItems}
        selectedStackTarget={stackTargetCard}
        isCastingTargetedSpell={isCastingTargetedSpell}
        canUseInstantActions={canUseInstantActions}
        canUseSorceryActions={canUseSorceryActions}
        landsPlayedThisTurn={turnState?.lands_played_this_turn ?? 0}
        landPlayLimit={turnState?.land_play_limit ?? 1}
        onClose={() => setSelectedCardId(null)}
        onShowStack={() => setActiveTab('stack')}
        onCastTargetedSpell={handleCastTargetedSpell}
      />

      <BottomActionDock
        canUseInstantActions={canUseInstantActions}
        isPassingPriority={isPassingPriority}
        libraryCount={libraryCount}
        graveyardCount={graveyardCount}
        stackCount={pendingStackItems.length}
        onPassPriority={handlePassPriority}
        onOpenStack={() => setActiveTab('stack')}
      />

      <BoardCardInspector card={inspectedBoardCard} onClose={() => setInspectedBoardCard(null)} />
      {errorMessage ? (
        <div className="fixed inset-x-3 bottom-24 z-[260] mx-auto max-w-md rounded-lg border border-red-400/20 bg-red-950/90 p-3 text-xs text-red-100 shadow-2xl">
          {errorMessage}
        </div>
      ) : null}
    </div>
  )
}

function ControllerStatusHeader({
  currentPlayer,
  turnState,
  manaPool,
  isPriority,
  isSessionFinished,
}: {
  currentPlayer: GameSessionPlayer | null
  turnState: GameTurnState | null
  manaPool: ManaPool
  isPriority: boolean
  isSessionFinished: boolean
}) {
  return (
    <section className={`rounded-lg border px-3 py-2.5 shadow-[0_14px_34px_rgba(0,0,0,0.24)] ${
      isPriority ? 'border-amber-300/60 bg-amber-400/12' : 'border-white/10 bg-slate-950/78'
    }`}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${isPriority ? 'bg-amber-300 shadow-[0_0_12px_rgba(252,211,77,0.8)]' : 'bg-slate-500'}`} />
            <p className={`truncate text-[10px] font-black uppercase tracking-[0.14em] ${isPriority ? 'text-amber-100' : 'text-cyan-200'}`}>
              {isSessionFinished ? 'Finished' : isPriority ? 'Your priority' : 'Waiting'}
            </p>
          </div>
          <div className="flex min-w-0 items-baseline gap-2">
            <h1 className="truncate text-base font-black text-white">{currentPlayer?.username ?? 'No player'}</h1>
            <span className="shrink-0 text-xs font-bold text-slate-400">P{currentPlayer?.seat_number ?? '-'}</span>
          </div>
          <p className="truncate text-xs text-slate-400">
            T{turnState?.turn_number ?? '-'} / {formatStepLabel(turnState?.step)} / {turnState?.priority_username ?? 'no priority'}
          </p>
        </div>
        <div className="grid grid-cols-[auto_auto] items-center gap-2">
          <MiniManaPool manaPool={manaPool} />
          <div className="text-right">
            <p className="text-3xl font-black leading-none text-white">{currentPlayer?.life_total ?? '-'}</p>
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">Life</p>
          </div>
        </div>
      </div>
    </section>
  )
}

function PriorityInbox({
  isVisible,
  pendingStackItems,
  combatAssignments,
  responseCards,
  selectedCardId,
  isPassingPriority,
  onSelectCard,
  onPassPriority,
}: {
  isVisible: boolean
  pendingStackItems: StackItem[]
  combatAssignments: CombatAssignment[]
  responseCards: ControllerCard[]
  selectedCardId?: string
  isPassingPriority: boolean
  onSelectCard: (cardId: string) => void
  onPassPriority: () => void
}) {
  if (!isVisible) {
    return null
  }

  const topStackItem = pendingStackItems[0] ?? null
  const activeCombatAssignments = combatAssignments.filter(
    (assignment) => assignment.blocker_count || assignment.blocker_card_id || assignment.attacker_card_id,
  )

  return (
    <section className="rounded-lg border border-amber-300/45 bg-amber-950/20 p-3 shadow-[0_0_28px_rgba(245,158,11,0.16)]">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Bell className="h-4 w-4 text-amber-200" aria-hidden="true" />
            <p className="text-xs font-black uppercase tracking-[0.14em] text-amber-100">Priority Inbox</p>
          </div>
          <p className="mt-1 truncate text-sm text-amber-50">
            {topStackItem
              ? `${topStackItem.source_card_name ?? topStackItem.action_type} is waiting`
              : activeCombatAssignments.length > 0
                ? `${activeCombatAssignments.length} combat assignment(s) active`
                : 'You can act now'}
          </p>
        </div>
        <button
          type="button"
          onClick={onPassPriority}
          disabled={isPassingPriority}
          className="min-h-11 rounded-md bg-amber-300 px-4 text-sm font-black text-amber-950 disabled:opacity-50"
        >
          {isPassingPriority ? 'Passing...' : 'Pass'}
        </button>
      </div>
      {activeCombatAssignments.length > 0 ? (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-red-300/20 bg-red-950/20 px-3 py-2 text-xs text-red-100">
          <Swords className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{activeCombatAssignments[0]?.attacker_name ?? 'Combat'} is in combat.</span>
        </div>
      ) : null}
      {responseCards.length > 0 ? (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {responseCards.slice(0, 8).map((card) => (
            <button
              key={card.id}
              type="button"
              onClick={() => onSelectCard(card.id)}
              className={`min-h-11 min-w-32 rounded-md border px-3 py-2 text-left ${
                selectedCardId === card.id
                  ? 'border-cyan-200 bg-cyan-400/15'
                  : 'border-white/10 bg-slate-950/65'
              }`}
            >
              <p className="truncate text-xs font-bold text-white">{card.name}</p>
              <p className="truncate text-[10px] text-slate-400">{card.cards?.mana_cost || card.zone}</p>
            </button>
          ))}
        </div>
      ) : (
        <p className="rounded-md border border-white/10 bg-slate-950/55 px-3 py-2 text-xs text-slate-300">
          No obvious responses available. You can still inspect your hand or pass priority.
        </p>
      )}
    </section>
  )
}

function ControllerTabs({
  activeTab,
  handCount,
  boardCount,
  opponentCount,
  stackCount,
  onChange,
}: {
  activeTab: ControllerTab
  handCount: number
  boardCount: number
  opponentCount: number
  stackCount: number
  onChange: (tab: ControllerTab) => void
}) {
  const tabs: Array<{ id: ControllerTab; label: string; count: number; icon: typeof Hand }> = [
    { id: 'hand', label: 'Hand', count: handCount, icon: Hand },
    { id: 'board', label: 'My Board', count: boardCount, icon: Layers },
    { id: 'opponents', label: 'Opponents', count: opponentCount, icon: Eye },
    { id: 'stack', label: 'Stack', count: stackCount, icon: Zap },
  ]

  return (
    <nav className="grid grid-cols-4 gap-1 rounded-lg border border-white/10 bg-slate-950/82 p-1">
      {tabs.map((tab) => {
        const Icon = tab.icon
        const isActive = activeTab === tab.id

        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className={`min-h-11 rounded-md px-1.5 py-1.5 text-center transition ${
              isActive ? 'bg-white text-slate-950' : 'text-slate-300 hover:bg-slate-800'
            }`}
          >
            <Icon className="mx-auto h-4 w-4" aria-hidden="true" />
            <span className="mt-0.5 block truncate text-[10px] font-black">{tab.label}</span>
            <span className="sr-only">{tab.count}</span>
          </button>
        )
      })}
    </nav>
  )
}

function HandView({
  cards,
  selectedCardId,
  canUseSorceryActions,
  canUseInstantActions,
  pendingStackCount,
  onSelectCard,
  onQuickCast,
}: {
  cards: ControllerCard[]
  selectedCardId?: string
  canUseSorceryActions: boolean
  canUseInstantActions: boolean
  pendingStackCount: number
  onSelectCard: (cardId: string) => void
  onQuickCast: (card: ControllerCard) => void
}) {
  if (cards.length === 0) {
    return <EmptyPanel title="Hand empty" description="Draw cards or wait for game state updates." />
  }

  return (
    <section className="grid gap-3">
      <div className="flex snap-x gap-3 overflow-x-auto pb-2">
        {cards.map((card) => {
          const isSelected = selectedCardId === card.id
          const canQuickCast = getCanQuickCast(card, canUseSorceryActions, canUseInstantActions, pendingStackCount)

          return (
            <article
              key={card.id}
              className={`w-[9.75rem] shrink-0 snap-center rounded-lg border bg-slate-950/72 p-2 shadow-xl shadow-black/20 ${
                isSelected ? 'border-white ring-2 ring-white/20' : 'border-white/10'
              }`}
            >
              <button type="button" onClick={() => onSelectCard(card.id)} className="block w-full text-left">
                <MotionCard
                  card={{
                    id: card.id,
                    name: card.name,
                    image_url: card.cards?.image_url,
                    is_tapped: card.is_tapped,
                    damage_marked: card.damage_marked,
                    zone: card.zone,
                  }}
                  size="board"
                  interactive
                  useLayoutId={false}
                  className="mx-auto max-w-32"
                />
                <div className="mt-2 min-w-0">
                  <p className="truncate text-sm font-bold text-white">{card.name}</p>
                  <p className="truncate text-xs text-slate-400">{card.cards?.mana_cost || card.cards?.type_line || 'Card'}</p>
                </div>
              </button>
              <button
                type="button"
                disabled={!canQuickCast}
                onClick={() => onQuickCast(card)}
                className="mt-2 min-h-10 w-full rounded-md bg-emerald-300 px-3 text-sm font-black text-emerald-950 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
              >
                {doesCardRequireStackTarget(card) ? 'Target' : 'Play'}
              </button>
            </article>
          )
        })}
      </div>
    </section>
  )
}

function MyBoardView({
  cards,
  selectedCardId,
  onSelectCard,
}: {
  cards: ControllerCard[]
  selectedCardId?: string
  onSelectCard: (cardId: string) => void
}) {
  if (cards.length === 0) {
    return <EmptyPanel title="No permanents" description="Your battlefield is empty." />
  }

  const lands = cards.filter(isLandCard)
  const permanents = cards.filter((card) => !isLandCard(card))

  return (
    <section className="grid gap-3">
      <CardGroup title="Permanents" cards={permanents} selectedCardId={selectedCardId} onSelectCard={onSelectCard} />
      <CardGroup title={`Lands / ${lands.filter((card) => !card.is_tapped).length}/${lands.length} ready`} cards={lands} selectedCardId={selectedCardId} onSelectCard={onSelectCard} compact />
    </section>
  )
}

function CardGroup({
  title,
  cards,
  selectedCardId,
  compact = false,
  onSelectCard,
}: {
  title: string
  cards: ControllerCard[]
  selectedCardId?: string
  compact?: boolean
  onSelectCard: (cardId: string) => void
}) {
  return (
    <section className="rounded-lg border border-white/10 bg-slate-950/65 p-3">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-black text-white">{title}</h2>
        <span className="text-xs text-slate-400">{cards.length}</span>
      </div>
      {cards.length > 0 ? (
        <div className={compact ? 'grid grid-cols-3 gap-2' : 'grid grid-cols-2 gap-3'}>
          {cards.map((card) => (
            <button
              key={card.id}
              type="button"
              onClick={() => onSelectCard(card.id)}
              className={`rounded-md border p-2 ${selectedCardId === card.id ? 'border-cyan-300 bg-cyan-400/10' : 'border-white/10 bg-black/20'}`}
            >
              <MotionCard
                card={{
                  id: card.id,
                  name: card.name,
                  image_url: card.cards?.image_url,
                  is_tapped: card.is_tapped,
                  damage_marked: card.damage_marked,
                  zone: card.zone,
                }}
                size="board"
                useLayoutId={false}
                className={compact ? 'mx-auto max-w-20' : 'mx-auto max-w-32'}
              />
              <p className="mt-2 truncate text-xs font-bold text-white">{card.name}</p>
            </button>
          ))}
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-white/10 px-3 py-6 text-center text-xs text-slate-500">
          None.
        </p>
      )}
    </section>
  )
}

function OpponentBattlefieldCarousel({
  players,
  boardCards,
  onInspectCard,
}: {
  players: GameSessionPlayer[]
  boardCards: BoardCard[]
  onInspectCard: (card: BoardCard) => void
}) {
  if (players.length === 0) {
    return <EmptyPanel title="No opponents" description="Other players will appear here once they join." />
  }

  return (
    <section className="flex snap-x gap-3 overflow-x-auto pb-2">
      {players.map((player) => {
        const playerCards = boardCards.filter((card) => card.controller_player_id === player.player_id)
        const readyCount = playerCards.filter((card) => !card.is_tapped).length

        return (
          <article key={player.player_id} className="min-w-full snap-center rounded-lg border border-white/10 bg-slate-950/70 p-3 shadow-xl shadow-black/20">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-black uppercase tracking-[0.14em] text-cyan-200">Opponent P{player.seat_number}</p>
                <h2 className="truncate text-lg font-black text-white">{player.username || `Player ${player.seat_number}`}</h2>
              </div>
              <div className="text-right">
                <p className="text-3xl font-black leading-none text-cyan-100">{player.life_total}</p>
                <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Life</p>
              </div>
            </div>
            <div className="mb-3 grid grid-cols-2 gap-2">
              <StatPill label="Battlefield" value={String(playerCards.length)} />
              <StatPill label="Ready" value={`${readyCount}/${playerCards.length}`} />
            </div>
            {playerCards.length > 0 ? (
              <div className="grid grid-cols-3 gap-2">
                {playerCards.map((card) => (
                  <button
                    key={card.id}
                    type="button"
                    onClick={() => onInspectCard(card)}
                    className="rounded-md border border-white/10 bg-black/20 p-1.5"
                  >
                    <MotionCard
                      card={{
                        id: card.id,
                        name: card.name,
                        image_url: card.image_url,
                        is_tapped: card.is_tapped,
                        damage_marked: card.damage_marked,
                        zone: card.zone,
                      }}
                      size="board"
                      useLayoutId={false}
                    />
                    <p className="mt-1 truncate text-[10px] font-bold text-white">{card.name}</p>
                  </button>
                ))}
              </div>
            ) : (
              <p className="rounded-md border border-dashed border-white/10 px-3 py-8 text-center text-xs text-slate-500">
                No permanents on battlefield.
              </p>
            )}
          </article>
        )
      })}
    </section>
  )
}

function StackView({
  items,
  selectedTargetId,
  onSelectTarget,
}: {
  items: StackItem[]
  selectedTargetId: string | null
  onSelectTarget: (targetId: string) => void
}) {
  if (items.length === 0) {
    return <EmptyPanel title="Stack empty" description="Spells and abilities waiting to resolve will appear here." />
  }

  return (
    <section className="grid gap-3">
      {items.map((item, index) => {
        const isSelected = selectedTargetId === item.id

        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelectTarget(item.id)}
            className={`min-h-20 rounded-lg border p-3 text-left ${
              isSelected ? 'border-red-300 bg-red-500/15' : 'border-white/10 bg-slate-950/70'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[10px] font-black uppercase tracking-[0.14em] text-red-200">Stack #{index + 1}</p>
                <h2 className="truncate text-sm font-black text-white">{item.source_card_name ?? item.action_type}</h2>
                <p className="truncate text-xs text-slate-400">
                  {item.controller_username ?? 'Unknown'} {item.target_username ? `-> ${item.target_username}` : ''}
                </p>
              </div>
              <Zap className="h-5 w-5 text-red-200" aria-hidden="true" />
            </div>
          </button>
        )
      })}
    </section>
  )
}

function SelectedCardSheet({
  card,
  playerId,
  sessionId,
  isSessionFinished,
  sessionPlayers,
  stackItems,
  selectedStackTarget,
  isCastingTargetedSpell,
  canUseInstantActions,
  canUseSorceryActions,
  landsPlayedThisTurn,
  landPlayLimit,
  onClose,
  onShowStack,
  onCastTargetedSpell,
}: {
  card: ControllerCard | null
  playerId: string | null
  sessionId: string
  isSessionFinished: boolean
  sessionPlayers: GameSessionPlayer[]
  stackItems: StackItem[]
  selectedStackTarget: StackItem | null
  isCastingTargetedSpell: boolean
  canUseInstantActions: boolean
  canUseSorceryActions: boolean
  landsPlayedThisTurn: number
  landPlayLimit: number
  onClose: () => void
  onShowStack: () => void
  onCastTargetedSpell: () => void
}) {
  if (!card) {
    return null
  }

  const powerToughness = getPowerToughnessLabel(card)
  const requiresStackTarget = card.zone === 'hand' && doesCardRequireStackTarget(card)

  return (
    <aside className="fixed inset-x-3 bottom-[4.75rem] z-[230] mx-auto max-w-md rounded-lg border border-white/10 bg-slate-950/95 p-3 shadow-[0_-18px_60px_rgba(0,0,0,0.5)] backdrop-blur landscape:right-3 landscape:left-auto landscape:w-[22rem]">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-cyan-200">Selected Card</p>
          <h2 className="truncate text-base font-black text-white">{card.name}</h2>
          <p className="truncate text-xs text-slate-400">{card.cards?.type_line ?? card.zone}</p>
        </div>
        <button type="button" onClick={onClose} className="flex h-11 w-11 items-center justify-center rounded-md border border-white/10 bg-slate-900 text-slate-200">
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
      <div className="grid max-h-[42svh] grid-cols-[5.5rem_minmax(0,1fr)] gap-3 overflow-auto pr-1">
        <MotionCard
          card={{
            id: card.id,
            name: card.name,
            image_url: card.cards?.image_url,
            is_tapped: card.is_tapped,
            damage_marked: card.damage_marked,
            zone: card.zone,
          }}
          size="preview"
          useLayoutId={false}
          className="w-full"
        />
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {card.cards?.mana_cost ? <Badge>{card.cards.mana_cost}</Badge> : null}
            {powerToughness ? <Badge>{powerToughness}</Badge> : null}
            {card.is_tapped ? <Badge tone="amber">Tapped</Badge> : null}
            {card.damage_marked > 0 ? <Badge tone="red">Damage {card.damage_marked}</Badge> : null}
          </div>

          {requiresStackTarget ? (
            <div className="rounded-md border border-red-300/25 bg-red-950/20 p-2">
              <p className="text-xs font-bold text-red-100">
                Target: {selectedStackTarget ? formatStackItemLabel(selectedStackTarget) : 'Choose a stack target'}
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={onShowStack}
                  className="min-h-11 rounded-md border border-white/10 bg-slate-900 px-3 text-xs font-bold text-white"
                >
                  Stack
                </button>
                <button
                  type="button"
                  disabled={!canUseInstantActions || !selectedStackTarget || isCastingTargetedSpell}
                  onClick={onCastTargetedSpell}
                  className="min-h-11 rounded-md bg-red-300 px-3 text-xs font-black text-red-950 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {isCastingTargetedSpell ? 'Casting...' : 'Confirm'}
                </button>
              </div>
            </div>
          ) : (
            <CardZoneControls
              cardId={card.id}
              zone={card.zone}
              disabled={isSessionFinished}
              sessionId={sessionId}
              manaCost={card.cards?.mana_cost}
              typeLine={card.cards?.type_line}
              landsPlayedThisTurn={landsPlayedThisTurn}
              landPlayLimit={landPlayLimit}
              canUseSorceryActions={canUseSorceryActions}
            />
          )}

          {playerId ? (
            <ActionButtons
              card={card}
              sessionId={sessionId}
              playerId={playerId}
              disabled={isSessionFinished}
              sessionPlayers={sessionPlayers}
              stackItems={stackItems}
              canUseInstantActions={canUseInstantActions}
              canUseSorceryActions={canUseSorceryActions}
            />
          ) : null}
        </div>
      </div>
    </aside>
  )
}

function BottomActionDock({
  canUseInstantActions,
  isPassingPriority,
  libraryCount,
  graveyardCount,
  stackCount,
  onPassPriority,
  onOpenStack,
}: {
  canUseInstantActions: boolean
  isPassingPriority: boolean
  libraryCount: number
  graveyardCount: number
  stackCount: number
  onPassPriority: () => void
  onOpenStack: () => void
}) {
  return (
    <footer className="fixed inset-x-0 bottom-0 z-[220] border-t border-white/10 bg-slate-950/95 px-3 py-3 shadow-[0_-12px_40px_rgba(0,0,0,0.42)] backdrop-blur">
      <div className="mx-auto grid max-w-md grid-cols-[1fr_1.35fr] gap-2 landscape:max-w-5xl">
        <button
          type="button"
          onClick={onOpenStack}
          className="min-h-12 rounded-md border border-white/10 bg-slate-900 px-3 text-left"
        >
          <p className="text-xs font-black text-white">Stack {stackCount}</p>
          <p className="text-[10px] text-slate-400">Lib {libraryCount} / Grave {graveyardCount}</p>
        </button>
        <button
          type="button"
          onClick={onPassPriority}
          disabled={!canUseInstantActions || isPassingPriority}
          className="min-h-12 rounded-md bg-amber-300 px-3 text-sm font-black text-amber-950 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {isPassingPriority ? 'Passing...' : canUseInstantActions ? 'Pass Priority' : 'Waiting'}
        </button>
      </div>
    </footer>
  )
}

function BoardCardInspector({ card, onClose }: { card: BoardCard | null; onClose: () => void }) {
  if (!card) {
    return null
  }

  return (
    <div className="fixed inset-0 z-[300] flex items-end bg-black/55 p-3 backdrop-blur-sm" onClick={onClose}>
      <motion.article
        initial={{ y: 24, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        className="mx-auto w-full max-w-md rounded-lg border border-white/10 bg-slate-950 p-3 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-[0.14em] text-cyan-200">Opponent Permanent</p>
            <h2 className="truncate text-base font-black text-white">{card.name}</h2>
          </div>
          <button type="button" onClick={onClose} className="flex h-11 w-11 items-center justify-center rounded-md border border-white/10 bg-slate-900">
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <MotionCard
          card={{
            id: card.id,
            name: card.name,
            image_url: card.image_url,
            is_tapped: card.is_tapped,
            damage_marked: card.damage_marked,
            zone: card.zone,
          }}
          size="preview"
          useLayoutId={false}
          className="mx-auto w-44"
        />
        <div className="mt-3 grid grid-cols-2 gap-2">
          <StatPill label="State" value={card.is_tapped ? 'Tapped' : 'Ready'} />
          <StatPill label="Damage" value={String(card.damage_marked)} />
        </div>
      </motion.article>
    </div>
  )
}

function formatStepLabel(step: GameTurnState['step'] | undefined) {
  if (!step) {
    return 'Waiting'
  }

  return step
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function formatStackItemLabel(item: StackItem) {
  return item.source_card_name ?? item.action_type
}
