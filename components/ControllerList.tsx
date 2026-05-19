// components/ControllerList.tsx
'use client'
import Image from 'next/image'
import { AnimatePresence, motion, useDragControls, type PanInfo } from 'framer-motion'
import { BookOpen, Layers, Skull, Zap, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  castCardFromHand,
  getErrorMessage,
  passPriority,
  putCounterSpellOnStack,
} from '@/lib/game/actions'
import { showDevControls } from '@/lib/game/dev'
import { parseManaCost } from '@/lib/game/mana'
import { getControllerCards } from '@/lib/game/data'
import {
  selectLegacyControllerViewModel,
  type LegacyControllerViewFocus,
} from '@/lib/game/legacy-controller-selectors'
import { useLegacyControllerGameState } from '@/lib/game/use-legacy-controller-game-state'
import type {
  BoardCard,
  CombatActionState,
  CombatAssignment,
    ControllerCard,
    GameSessionPlayer,
    ManaColor,
    ManaPool,
    StackItem,
  } from '@/lib/game/types'
import ActionButtons from './ActionButtons'
import CardZoneControls from './CardZoneControls'
import MotionCard from './MotionCard'

const manaColorsForDisplay: Array<{
  color: ManaColor
  label: string
  className: string
}> = [
  { color: 'W', label: 'White', className: '' },
  { color: 'U', label: 'Blue', className: '' },
  { color: 'B', label: 'Black', className: '' },
  { color: 'R', label: 'Red', className: '' },
  { color: 'G', label: 'Green', className: '' },
  { color: 'C', label: 'Colorless', className: '' },
]

const cockpitPanelClass =
  'rounded-lg border border-white/10 bg-slate-950/72 shadow-[0_18px_46px_rgba(0,0,0,0.34)] backdrop-blur'
const cockpitPanelStrongClass =
  'rounded-lg border border-white/10 bg-slate-950/88 shadow-[0_20px_54px_rgba(0,0,0,0.42)] backdrop-blur'
const cockpitSoftPanelClass = 'rounded-md border border-white/10 bg-white/[0.045]'
const cockpitLabelClass = 'text-[10px] font-black uppercase tracking-[0.14em] text-cyan-200/85'
const cockpitMutedClass = 'text-slate-400'
const cockpitButtonClass =
  'rounded-md border border-white/10 bg-slate-900/90 text-slate-100 transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-45'
const priorityButtonClass =
  'rounded-md bg-amber-300 text-amber-950 shadow-[0_0_28px_rgba(245,158,11,0.18)]'

function getCockpitSelectionClass(isSelected: boolean, tone: 'cyan' | 'red' = 'cyan') {
  if (!isSelected) {
    return 'border-white/10 bg-black/20 hover:border-white/20 hover:bg-white/[0.055]'
  }

  return tone === 'red'
    ? 'border-red-300/60 bg-red-500/15 ring-2 ring-red-300/15'
    : 'border-cyan-300/60 bg-cyan-400/12 ring-2 ring-cyan-300/15'
}

function getCockpitBadgeClass(tone: 'slate' | 'amber' | 'red' | 'emerald' | 'cyan' = 'slate') {
  const toneClass = {
    slate: 'border-white/15 bg-white/10 text-slate-100',
    amber: 'border-amber-300/30 bg-amber-500/15 text-amber-100',
    red: 'border-red-300/30 bg-red-500/15 text-red-100',
    emerald: 'border-emerald-300/30 bg-emerald-500/15 text-emerald-100',
    cyan: 'border-cyan-300/30 bg-cyan-400/15 text-cyan-100',
  }[tone]

  return `rounded-md border px-2 py-0.5 ${toneClass}`
}

function getCockpitTileToneClass(tone: 'cyan' | 'slate' | 'amber' | 'emerald') {
  return {
    slate: 'border-white/10 bg-white/[0.045] text-slate-100',
    amber: 'border-amber-300/20 bg-amber-500/10 text-amber-100',
    emerald: 'border-emerald-300/20 bg-emerald-500/10 text-emerald-100',
    cyan: 'border-cyan-300/20 bg-cyan-400/10 text-cyan-100',
  }[tone]
}

export default function ControllerList({ sessionId }: { sessionId: string }) {
  const {
    supabase,
    cards,
    allBoardCards,
    isLoading,
    errorMessage,
    lastFetchInfo,
    playerId,
    combatActionState,
    combatAssignments,
    isSessionFinished,
    sessionPlayers,
    turnState,
    stackItems,
    manaPool,
    pendingStackCount,
    setCards,
    setErrorMessage,
    setTurnState,
  } = useLegacyControllerGameState(sessionId)
  const [draftedCardId, setDraftedCardId] = useState<string | null>(null)
  const [swipeCastingCardId, setSwipeCastingCardId] = useState<string | null>(null)
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null)
  const [isPassingPriority, setIsPassingPriority] = useState(false)
  const [isHandRaised, setIsHandRaised] = useState(false)
  const [isTargeting, setIsTargeting] = useState(false)
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null)
  const [isCastingTargetedSpell, setIsCastingTargetedSpell] = useState(false)
  // 'me' toont je eigen hand/board. De andere tonen de specifieke tegenstander
  const [viewFocus, setViewFocus] = useState<LegacyControllerViewFocus>('me')
  const [handOrder, setHandOrder] = useState<string[]>([])
  const [previewCard, setPreviewCard] = useState<ControllerCard | BoardCard | null>(null)
  const handContainerRef = useRef<HTMLDivElement | null>(null)
  const attackTargetElements = useRef(new Map<string, HTMLElement>())
  const blockTargetElements = useRef(new Map<string, HTMLElement>())
  const playDropZoneRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    setHandOrder((currentOrder) => {
      const handIds = cards.filter((card) => card.zone === 'hand').map((card) => card.id)
      const keptIds = currentOrder.filter((cardId) => handIds.includes(cardId))
      const newIds = handIds.filter((cardId) => !keptIds.includes(cardId))

      return [...keptIds, ...newIds]
    })
  }, [cards])

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!isHandRaised) {
        return
      }

      const target = event.target
      if (target instanceof Node && handContainerRef.current?.contains(target)) {
        return
      }

      setIsHandRaised(false)
    }

    window.addEventListener('pointerdown', handlePointerDown)

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [isHandRaised])

  useEffect(() => {
    setIsTargeting(false)
    setSelectedTargetId(null)
  }, [selectedCardId])

  useEffect(() => {
    if (
      viewFocus !== 'me' &&
      !sessionPlayers.some((player) => `opponent_${player.player_id}` === viewFocus)
    ) {
      setViewFocus('me')
    }
  }, [sessionPlayers, viewFocus])

  const registerAttackTargetRef = useCallback((playerId: string, element: HTMLElement | null) => {
    updateElementRefMap(attackTargetElements.current, playerId, element)
  }, [])

  const registerBlockTargetRef = useCallback((attackerCardId: string, element: HTMLElement | null) => {
    updateElementRefMap(blockTargetElements.current, attackerCardId, element)
  }, [])

  if (isLoading) {
    return <p>Loading cards...</p>
  }

  if (errorMessage) {
    return (
      <div className="p-4 text-sm">
        Could not load cards: {errorMessage}
      </div>
    )
  }

  const {
    handCards,
    orderedHandCards,
    battlefieldCards,
    selectedCard,
    currentPlayer,
    focusTabs,
    focusedOpponentPlayer,
    focusedOpponentBoardCards,
    libraryCount,
    defendingPlayers,
    blockableAssignments,
    canUseInstantActions,
    canUseSorceryActions,
    pendingStackItems,
  } = selectLegacyControllerViewModel({
    cards,
    allBoardCards,
    handOrder,
    draftedCardId,
    selectedCardId,
    sessionPlayers,
    playerId,
    viewFocus,
    combatActionState,
    combatAssignments,
    isSessionFinished,
    stackItems,
    pendingStackCount,
  })
  const attackUnavailableReason = getAttackUnavailableReason({
    combatActionState,
    defendingPlayers,
    isSessionFinished,
  })
  const canDeclareAttackers = !attackUnavailableReason
  const blockUnavailableReason = getBlockUnavailableReason({
    combatActionState,
    blockableAssignments,
    isSessionFinished,
  })
  const canDeclareBlockers = !blockUnavailableReason
  const shouldShowCombatTargets = isCombatInteractionStep(combatActionState?.step)
  const requiresTarget = selectedCard ? doesCardRequireStackTarget(selectedCard) : false
  const selectedTargetName = selectedTargetId
    ? formatStackTargetLabel(pendingStackItems.find((item) => item.id === selectedTargetId) ?? null)
    : null

  const castSelectedCard = async (card: ControllerCard, targetStackItemId?: string | null) => {
    if (doesCardRequireStackTarget(card)) {
      if (!targetStackItemId) {
        setSelectedCardId(card.id)
        setIsTargeting(true)
        return
      }

      setErrorMessage(null)
      setIsCastingTargetedSpell(true)

      try {
        await putCounterSpellOnStack(supabase, sessionId, targetStackItemId, card.id)
        setIsTargeting(false)
        setSelectedTargetId(null)
        if (playerId) {
          const result = await getControllerCards(supabase, sessionId, playerId)
          setCards(result.cards)
        }
      } catch (error) {
        const message = getErrorMessage(error)
        console.error('Failed to cast targeted spell:', message, error)
        setErrorMessage(message)
      } finally {
        setIsCastingTargetedSpell(false)
      }
      return
    }

    await castCardFromHand(supabase, sessionId, card.id)
    if (playerId) {
      const result = await getControllerCards(supabase, sessionId, playerId)
      setCards(result.cards)
    }
  }

  const handleConfirmTargetedCast = async () => {
    if (!selectedCard) {
      return
    }

    await castSelectedCard(selectedCard, selectedTargetId)
  }

  const handleSwipeCast = async (card: ControllerCard, info: PanInfo) => {
    if (card.zone !== 'hand') {
      return
    }

    const wasThrownToPlay =
      isPointInElement(info, playDropZoneRef.current) || info.offset.y <= -80 || info.velocity.y <= -450

    if (!wasThrownToPlay) {
      return
    }

    setSelectedCardId(card.id)
    setDraftedCardId(card.id)

    if (doesCardRequireStackTarget(card)) {
      if (!canUseInstantActions) {
        return
      }

      setIsTargeting(true)
      return
    }

    const swipeEligibility = getSwipeCastEligibility({
      card,
      isSessionFinished,
      canUseSorceryActions,
      landsPlayedThisTurn: turnState?.lands_played_this_turn ?? 0,
      landPlayLimit: turnState?.land_play_limit ?? 1,
    })

    if (!swipeEligibility.canCast) {
      return
    }

    setErrorMessage(null)
    setSwipeCastingCardId(card.id)

    try {
      await castSelectedCard(card)
      setDraftedCardId(null)
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to swipe-cast card:', message, error)
      setErrorMessage(message)
    } finally {
      setSwipeCastingCardId(null)
    }
  }

  const handleHandReorder = (cardId: string, direction: -1 | 1) => {
    setHandOrder((currentOrder) => {
      const nextOrder = currentOrder.length > 0 ? [...currentOrder] : handCards.map((card) => card.id)
      const currentIndex = nextOrder.indexOf(cardId)
      const nextIndex = currentIndex + direction

      if (currentIndex < 0 || nextIndex < 0 || nextIndex >= nextOrder.length) {
        return currentOrder
      }

      const [movedCardId] = nextOrder.splice(currentIndex, 1)
      nextOrder.splice(nextIndex, 0, movedCardId)

      return nextOrder
    })
  }

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

  const closePreview = () => setPreviewCard(null)

  return (
    <div className="relative h-[100svh] overflow-hidden p-2 pt-10 text-white landscape:h-screen">
      <div className="pointer-events-none absolute inset-0 opacity-70">
        <div className="leyline-table-grid absolute inset-0 opacity-10" />
        <div className="absolute inset-x-8 top-24 h-px bg-cyan-200/15" />
        <div className="absolute -bottom-28 left-1/2 h-80 w-[46rem] -translate-x-1/2 rounded-[100%] bg-cyan-500/10 blur-3xl" />
      </div>
      {lastFetchInfo && showDevControls ? <span className="sr-only">{lastFetchInfo}</span> : null}
      <div className="relative z-10 grid h-[calc(100svh-3rem)] grid-cols-1 grid-rows-[minmax(0,1fr)_minmax(12rem,38svh)] gap-3 overflow-hidden landscape:grid-cols-[13rem_minmax(0,1fr)_20rem] landscape:grid-rows-none landscape:overflow-visible [@media(max-height:760px)]:landscape:grid-cols-[10rem_minmax(0,1fr)_16rem] [@media(max-height:760px)]:gap-2">
        <aside className={`relative z-20 hidden min-h-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-3 overflow-hidden p-2 landscape:grid [@media(max-height:760px)]:gap-2 ${cockpitPanelClass}`}>
          <ControllerPlayerPanel
            currentPlayer={currentPlayer}
            isPriority={Boolean(playerId && turnState?.priority_player_id === playerId)}
          />
          <ControllerEconomyPanel
            manaPool={manaPool}
            lands={battlefieldCards.filter(isLandCard)}
            selectedCardId={selectedCard?.id}
            onSelectCard={setSelectedCardId}
          />
          {shouldShowCombatTargets ? (
            <ControllerCombatTargets
              canDeclareAttackers={canDeclareAttackers}
              attackUnavailableReason={attackUnavailableReason}
              defendingPlayers={defendingPlayers}
              canDeclareBlockers={canDeclareBlockers}
              blockUnavailableReason={blockUnavailableReason}
              blockableAssignments={blockableAssignments}
              registerAttackTargetRef={registerAttackTargetRef}
              registerBlockTargetRef={registerBlockTargetRef}
              compact
            />
          ) : null}
        </aside>

        <main className="relative z-[80] grid min-h-0 grid-rows-[auto_1fr] overflow-visible p-2">
          <ControllerFocusTabs tabs={focusTabs} viewFocus={viewFocus} onViewFocusChange={setViewFocus} />
          <div className="relative flex min-h-0 items-end justify-center overflow-visible">
            <AnimatePresence mode="wait" initial={false}>
              {viewFocus === 'me' && isTargeting && requiresTarget ? (
                <motion.div
                  key="targeting"
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  transition={{ duration: 0.16 }}
                  className="absolute inset-0 min-h-0 overflow-hidden p-4 [@media(max-height:760px)]:p-3"
                >
                  <StackTargetSelector
                    items={pendingStackItems}
                    selectedTargetId={selectedTargetId}
                    onSelectTarget={setSelectedTargetId}
                  />
                </motion.div>
              ) : viewFocus === 'me' ? (
                <motion.div
                  key="me"
                  initial={{ opacity: 0, x: -18 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 18 }}
                  transition={{ duration: 0.18 }}
                  className="absolute inset-0 flex items-end justify-center overflow-visible"
                >
                  <div className="absolute inset-0 min-h-0 overflow-hidden p-4 pb-40 [@media(max-height:760px)]:p-3 [@media(max-height:760px)]:pb-28">
                    <ControllerBattlefieldGrid
                      cards={battlefieldCards}
                      selectedCardId={selectedCard?.id}
                      onSelect={setSelectedCardId}
                      onPreviewStart={setPreviewCard}
                      onPreviewEnd={closePreview}
                    />
                  </div>
                  <PlayDropZone
                    refCallback={(element) => {
                      playDropZoneRef.current = element
                    }}
                    selectedCard={selectedCard}
                    canUseSorceryActions={canUseSorceryActions}
                    isHandRaised={isHandRaised}
                  />
                  <ControllerHandFan
                    cards={orderedHandCards}
                    selectedCardId={selectedCard?.id}
                    swipeCastingCardId={swipeCastingCardId}
                    isRaised={isHandRaised}
                    handContainerRef={handContainerRef}
                    onSelect={setSelectedCardId}
                    onRaiseChange={setIsHandRaised}
                    onReorder={handleHandReorder}
                    onSwipeCast={handleSwipeCast}
                    onPreviewStart={setPreviewCard}
                    onPreviewEnd={closePreview}
                  />
                </motion.div>
              ) : (
                <motion.div
                  key={viewFocus}
                  initial={{ opacity: 0, x: 18 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -18 }}
                  transition={{ duration: 0.18 }}
                  className="absolute inset-0 min-h-0 overflow-hidden p-4 [@media(max-height:760px)]:p-3"
                >
                  <OpponentBoardView
                    player={focusedOpponentPlayer}
                    cards={focusedOpponentBoardCards}
                    onPreviewStart={setPreviewCard}
                    onPreviewEnd={closePreview}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </main>

        <aside className="relative z-30 grid h-full min-h-0 grid-rows-[12.5rem_minmax(0,1fr)] gap-3 overflow-hidden [@media(max-height:760px)]:grid-rows-[10.75rem_minmax(0,1fr)] [@media(max-height:760px)]:gap-2">
          <div className="min-h-0 overflow-hidden">
            <ControllerActionPad
              canPassPriority={canUseInstantActions}
              isPassingPriority={isPassingPriority}
              onPassPriority={handlePassPriority}
              libraryCount={libraryCount}
              graveyardCount={cards.filter((card) => card.zone === 'graveyard').length}
              stackCount={pendingStackCount}
              manaPool={manaPool}
            />
          </div>
          <div className="min-h-0 overflow-hidden">
            <SelectedCardDock
              card={selectedCard}
              playerId={playerId}
              sessionId={sessionId}
              isSessionFinished={isSessionFinished}
              sessionPlayers={sessionPlayers}
              stackItems={stackItems}
              canUseInstantActions={canUseInstantActions}
              canUseSorceryActions={canUseSorceryActions}
              requiresTarget={requiresTarget}
              isTargeting={isTargeting}
              selectedTargetName={selectedTargetName}
              selectedTargetId={selectedTargetId}
              isCastingTargetedSpell={isCastingTargetedSpell}
              onStartTargeting={() => setIsTargeting(true)}
              onCancelTargeting={() => {
                setIsTargeting(false)
                setSelectedTargetId(null)
              }}
              onConfirmTargetedCast={handleConfirmTargetedCast}
              landsPlayedThisTurn={turnState?.lands_played_this_turn ?? 0}
              landPlayLimit={turnState?.land_play_limit ?? 1}
              onPreviewStart={setPreviewCard}
              onPreviewEnd={closePreview}
            />
          </div>
        </aside>
      </div>
      {previewCard ? (
        <div
          className="fixed inset-0 z-[300] flex items-center justify-center"
          onPointerUp={closePreview}
          onPointerCancel={closePreview}
          onPointerLeave={closePreview}
        >
          <div className="relative aspect-[2/3] w-[min(13rem,42vw,62vh)] animate-in zoom-in-95 duration-150">
            {getPreviewCardImageUrl(previewCard) ? (
              <Image
                src={getPreviewCardImageUrl(previewCard) as string}
                alt={previewCard.name}
                fill
                draggable={false}
                sizes="384px"
                className="object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center p-4 text-center">
                <p className="text-lg font-black">{previewCard.name}</p>
              </div>
            )}
          </div>
        </div>
      ) : null}
      {handCards.length === 0 && battlefieldCards.length === 0 ? (
        <div className="p-4 text-sm">
          No cards in hand or on battlefield.
        </div>
      ) : null}
    </div>
  )
}

function ControllerPlayerPanel({
  currentPlayer,
  isPriority,
}: {
  currentPlayer: GameSessionPlayer | null
  isPriority: boolean
}) {
  return (
    <section className={`p-2 [@media(max-height:760px)]:p-1 ${isPriority ? 'rounded-lg border border-amber-300/50 bg-amber-400/12 shadow-[0_0_26px_rgba(245,158,11,0.14)]' : ''}`}>
      <div className="flex items-center gap-3">
        <div className="flex h-16 w-16 items-center justify-center rounded-lg border border-cyan-300/20 bg-cyan-400/10 text-lg font-black text-cyan-100 [@media(max-height:760px)]:h-12 [@media(max-height:760px)]:w-12">
          P{currentPlayer?.seat_number ?? '-'}
        </div>
        <div className="min-w-0">
          <p className={isPriority ? 'text-xs font-black uppercase tracking-[0.16em] text-amber-100' : cockpitLabelClass}>
            P{currentPlayer?.seat_number ?? '-'} {isPriority ? '- Priority' : ''}
          </p>
          <p className="truncate text-sm font-black text-white">
            {currentPlayer?.username ?? 'No player'}
          </p>
          <p className="mt-1 text-2xl font-black leading-none text-white [@media(max-height:760px)]:text-xl">{currentPlayer?.life_total ?? '-'}</p>
          <p className={`text-[10px] font-bold uppercase tracking-[0.16em] ${cockpitMutedClass}`}>Life</p>
        </div>
      </div>
    </section>
  )
}

function ControllerEconomyPanel({
  manaPool,
  lands,
  selectedCardId,
  onSelectCard,
}: {
  manaPool: ManaPool
  lands: ControllerCard[]
  selectedCardId?: string
  onSelectCard: (cardId: string) => void
}) {
  const totalMana = getManaPoolTotal(manaPool)
  const untappedLands = lands.filter((card) => !card.is_tapped).length

  return (
    <section className={`relative overflow-hidden p-2 [@media(max-height:760px)]:p-1 ${cockpitSoftPanelClass}`}>
      <div className="relative mb-3 flex items-center justify-between gap-3 [@media(max-height:760px)]:mb-2">
        <div>
          <p className={cockpitLabelClass}>The Economy</p>
          <p className="text-sm font-black text-white [@media(max-height:760px)]:text-xs">
            {totalMana > 0 ? `${totalMana} Mana` : 'Empty Pool'}
          </p>
        </div>
        <span className={`${getCockpitBadgeClass(untappedLands > 0 ? 'emerald' : 'slate')} text-[10px] font-black uppercase`}>
          {untappedLands}/{lands.length} ready
        </span>
      </div>

      <MiniManaPool manaPool={manaPool} compact />

      <div className="relative mt-3 [@media(max-height:760px)]:mt-2">
        <div className={`mb-2 flex items-center justify-between ${cockpitLabelClass}`}>
          <span>Lands</span>
          <span>{lands.length}</span>
        </div>
        {lands.length > 0 ? (
          <div className="grid grid-cols-1 gap-1.5 overflow-hidden">
            {lands.slice(0, 6).map((card) => (
              <button
                key={card.id}
                type="button"
                onClick={() => onSelectCard(card.id)}
                className={`relative grid h-12 min-w-0 grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-2 overflow-hidden rounded-md border p-1.5 text-left transition-colors [@media(max-height:760px)]:h-10 ${getCockpitSelectionClass(selectedCardId === card.id)}`}
              >
                <div className={`relative h-9 w-7 overflow-hidden [@media(max-height:760px)]:h-7 [@media(max-height:760px)]:w-6 ${
                  card.is_tapped ? 'rotate-90 opacity-75' : ''
                }`}>
                  {card.cards?.image_url ? (
                    <Image
                      src={card.cards.image_url}
                      alt={card.name || 'Land card'}
                      fill
                      draggable={false}
                      sizes="32px"
                      className="object-cover"
                    />
                  ) : null}
                </div>
                <span className="truncate text-xs font-bold text-white [@media(max-height:760px)]:text-[10px]">
                  {card.name}
                </span>
                <span className={`${getCockpitBadgeClass(card.is_tapped ? 'amber' : 'emerald')} px-1.5 py-0.5 text-[9px] font-bold uppercase`}>
                  {card.is_tapped ? 'Tapped' : 'Ready'}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className={`px-2 py-3 text-center text-xs ${cockpitMutedClass} [@media(max-height:760px)]:py-2`}>
            No lands on battlefield.
          </div>
        )}
      </div>
    </section>
  )
}

function ControllerFocusTabs({
  tabs,
  viewFocus,
  onViewFocusChange,
}: {
  tabs: Array<{ id: LegacyControllerViewFocus; player: GameSessionPlayer | null }>
  viewFocus: LegacyControllerViewFocus
  onViewFocusChange: (focus: LegacyControllerViewFocus) => void
}) {
  return (
    <motion.nav
      className={`mb-3 grid h-16 gap-1.5 overflow-x-auto p-1.5 [@media(max-height:760px)]:mb-2 [@media(max-height:760px)]:h-12 ${cockpitPanelClass}`}
      style={{ gridTemplateColumns: `repeat(${Math.max(tabs.length, 1)}, minmax(7rem, 1fr))` }}
    >
      {tabs.map((tab, index) => {
        const isActive = viewFocus === tab.id
        const label = tab.player?.username || (tab.id === 'me' ? 'You' : `Opponent ${index}`)
        const life = tab.player?.life_total ?? '-'

        return (
          <button
            key={tab.id}
            type="button"
            disabled={!tab.player}
            onClick={() => onViewFocusChange(tab.id)}
            className={`min-w-0 rounded-md border px-2 py-1 text-left transition disabled:cursor-not-allowed disabled:opacity-25 ${
              isActive
                ? 'border-cyan-500 bg-cyan-400/12 text-cyan-50 shadow-[0_0_10px_rgba(34,211,238,0.3)]'
                : 'border-white/10 bg-slate-950/50 text-slate-400 opacity-70 hover:bg-slate-900 hover:text-slate-200 hover:opacity-100'
            }`}
          >
            <span className="block truncate text-xs font-black [@media(max-height:760px)]:text-[10px]">{label}</span>
            <span className="mt-0.5 block text-[10px] font-bold uppercase tracking-[0.12em] [@media(max-height:760px)]:hidden">
              [{life}]
            </span>
          </button>
        )
      })}
    </motion.nav>
  )
}

function ControllerBattlefieldGrid({
  cards,
  selectedCardId,
  onSelect,
  onPreviewStart,
  onPreviewEnd,
}: {
  cards: ControllerCard[]
  selectedCardId?: string
  onSelect: (cardId: string) => void
  onPreviewStart: (card: ControllerCard) => void
  onPreviewEnd: () => void
}) {
  const landCards = cards.filter(isLandCard)
  const nonLandCards = cards.filter((card) => !isLandCard(card))
  const readyLandCount = landCards.filter((card) => !card.is_tapped).length

  return (
    <section className={`relative h-full min-h-0 overflow-hidden p-3 ${cockpitPanelClass}`}>
      <div className="relative mb-3 flex items-center justify-between gap-3">
        <div>
          <p className={cockpitLabelClass}>Center View</p>
          <h2 className="text-sm font-black text-white">Battlefield</h2>
        </div>
        <span className={`${getCockpitBadgeClass('cyan')} px-3 py-1 text-xs font-black`}>
          {cards.length}
        </span>
      </div>
      {cards.length > 0 ? (
        <div className="relative grid max-h-[calc(100%-3.25rem)] gap-4 overflow-auto pr-1 [@media(max-height:760px)]:gap-3">
          <BattlefieldCardGroup
            title="Permanents"
            cards={nonLandCards}
            selectedCardId={selectedCardId}
            onSelect={onSelect}
            onPreviewStart={onPreviewStart}
            onPreviewEnd={onPreviewEnd}
          />
          <BattlefieldCardGroup
            title="Lands"
            meta={`${readyLandCount}/${landCards.length} ready`}
            cards={landCards}
            selectedCardId={selectedCardId}
            onSelect={onSelect}
            onPreviewStart={onPreviewStart}
            onPreviewEnd={onPreviewEnd}
            compact
          />
        </div>
      ) : (
        <div className={`relative flex h-[calc(100%-3.25rem)] items-center justify-center text-xs ${cockpitMutedClass}`}>
          No permanents on battlefield.
        </div>
      )}
    </section>
  )
}

function OpponentBoardView({
  player,
  cards,
  onPreviewStart,
  onPreviewEnd,
}: {
  player: GameSessionPlayer | null
  cards: BoardCard[]
  onPreviewStart: (card: BoardCard) => void
  onPreviewEnd: () => void
}) {
  const landCards = cards.filter(isBoardLandCard)
  const nonLandCards = cards.filter((card) => !isBoardLandCard(card))
  const readyLandCount = landCards.filter((card) => !card.is_tapped).length

  return (
    <section className={`relative h-full min-h-0 overflow-hidden p-3 ${cockpitPanelClass}`}>
      <div className="relative mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className={cockpitLabelClass}>Opponent Board</p>
          <h2 className="truncate text-sm font-black text-white">
            {player?.username || 'No opponent selected'}
          </h2>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-2xl font-black leading-none text-cyan-100">{player?.life_total ?? '-'}</p>
          <p className={`text-[10px] font-bold uppercase tracking-[0.12em] ${cockpitMutedClass}`}>Life</p>
        </div>
      </div>

      {player ? (
        <div className="relative grid max-h-[calc(100%-3.25rem)] gap-4 overflow-auto pr-1 [@media(max-height:760px)]:gap-3">
          <OpponentBoardCardGroup
            title="Permanents"
            cards={nonLandCards}
            onPreviewStart={onPreviewStart}
            onPreviewEnd={onPreviewEnd}
          />
          <OpponentBoardCardGroup
            title="Lands"
            meta={`${readyLandCount}/${landCards.length} ready`}
            cards={landCards}
            onPreviewStart={onPreviewStart}
            onPreviewEnd={onPreviewEnd}
            compact
          />
        </div>
      ) : (
        <div className={`relative flex h-[calc(100%-3.25rem)] items-center justify-center text-xs ${cockpitMutedClass}`}>
          This opponent slot is empty.
        </div>
      )}
    </section>
  )
}

function OpponentBoardCardGroup({
  title,
  meta,
  cards,
  compact = false,
  onPreviewStart,
  onPreviewEnd,
}: {
  title: string
  meta?: string
  cards: BoardCard[]
  compact?: boolean
  onPreviewStart: (card: BoardCard) => void
  onPreviewEnd: () => void
}) {
  return (
    <div className="relative">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className={cockpitLabelClass}>{title}</p>
        {meta ? <p className={`text-[10px] font-bold uppercase tracking-[0.12em] ${cockpitMutedClass}`}>{meta}</p> : null}
      </div>
      {cards.length > 0 ? (
        <div className={`grid gap-3 [@media(max-height:760px)]:gap-2 ${
          compact
            ? 'grid-cols-5 [@media(max-height:760px)]:grid-cols-6'
            : 'grid-cols-3 sm:grid-cols-4 [@media(max-height:760px)]:grid-cols-5'
        }`}>
          {cards.map((card) => (
            <button
              key={card.id}
              type="button"
              onPointerDown={() => onPreviewStart(card)}
              onPointerUp={onPreviewEnd}
              onPointerLeave={onPreviewEnd}
              onPointerCancel={onPreviewEnd}
              className="min-w-0 rounded-md border border-white/10 bg-black/20 p-1.5 text-left transition-colors hover:border-cyan-300/35 hover:bg-cyan-400/10"
            >
              <div
                className="transition-transform duration-200 ease-in-out"
                style={isBoardLandCard(card) && card.is_tapped ? { transform: 'rotate(45deg)' } : undefined}
              >
                <MotionCard
                  card={{
                    id: card.id,
                    name: card.name,
                    image_url: card.image_url,
                    is_tapped: isBoardLandCard(card) ? false : card.is_tapped,
                    damage_marked: card.damage_marked,
                    zone: card.zone,
                  }}
                  size={compact ? 'preview' : 'board'}
                  showNameFallback
                />
              </div>
              <p className="mt-2 truncate text-xs font-bold text-white [@media(max-height:760px)]:mt-1 [@media(max-height:760px)]:text-[10px]">
                {card.name}
              </p>
            </button>
          ))}
        </div>
      ) : (
        <div className={`rounded-md border border-dashed border-white/10 px-3 py-4 text-center text-xs font-semibold ${cockpitMutedClass}`}>
          No {title.toLowerCase()}.
        </div>
      )}
    </div>
  )
}

function StackTargetSelector({
  items,
  selectedTargetId,
  onSelectTarget,
}: {
  items: StackItem[]
  selectedTargetId: string | null
  onSelectTarget: (targetId: string) => void
}) {
  return (
    <section className={`relative grid h-full min-h-0 grid-rows-[auto_1fr] overflow-hidden p-3 ${cockpitPanelStrongClass}`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-red-200">Targeting Mode</p>
          <h2 className="text-sm font-black text-white">Select a spell on the stack</h2>
        </div>
        <span className={`${getCockpitBadgeClass('red')} text-[10px] font-black uppercase`}>
          {items.length} pending
        </span>
      </div>

      {items.length > 0 ? (
        <div className="grid content-start gap-3 overflow-auto pr-1">
          {items.map((item) => {
            const isSelected = selectedTargetId === item.id

            return (
              <motion.button
                key={item.id}
                type="button"
                onClick={() => onSelectTarget(item.id)}
                className={`grid gap-1 rounded-lg border p-4 text-left transition ${getCockpitSelectionClass(isSelected, 'red')}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="truncate text-base font-black text-white">{formatStackTargetLabel(item)}</p>
                  <span className={`${getCockpitBadgeClass('red')} text-[10px] font-bold uppercase`}>
                    #{item.position + 1}
                  </span>
                </div>
                <p className={`truncate text-xs font-medium ${cockpitMutedClass}`}>
                  {item.controller_username ?? item.controller_player_id.slice(0, 8)} - {item.action_type}
                </p>
              </motion.button>
            )
          })}
        </div>
      ) : (
        <div className={`flex items-center justify-center p-4 text-center text-sm font-semibold ${cockpitMutedClass}`}>
          No pending stack items.
        </div>
      )}
    </section>
  )
}

function BattlefieldCardGroup({
  title,
  meta,
  cards,
  selectedCardId,
  onSelect,
  onPreviewStart,
  onPreviewEnd,
  compact = false,
}: {
  title: string
  meta?: string
  cards: ControllerCard[]
  selectedCardId?: string
  onSelect: (cardId: string) => void
  onPreviewStart: (card: ControllerCard) => void
  onPreviewEnd: () => void
  compact?: boolean
}) {
  return (
    <div className="relative">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className={cockpitLabelClass}>{title}</p>
        {meta ? <p className={`text-[10px] font-bold uppercase tracking-[0.12em] ${cockpitMutedClass}`}>{meta}</p> : null}
      </div>
      {cards.length > 0 ? (
        <div className={`grid gap-3 [@media(max-height:760px)]:gap-2 ${
          compact
            ? 'grid-cols-5 [@media(max-height:760px)]:grid-cols-6'
            : 'grid-cols-3 sm:grid-cols-4 [@media(max-height:760px)]:grid-cols-5'
        }`}>
          {cards.map((card) => (
            <button
              key={card.id}
              type="button"
              onClick={() => onSelect(card.id)}
              onPointerDown={() => onPreviewStart(card)}
              onPointerUp={onPreviewEnd}
              onPointerLeave={onPreviewEnd}
              onPointerCancel={onPreviewEnd}
              className={`min-w-0 rounded-md border p-1.5 text-left transition-colors ${getCockpitSelectionClass(selectedCardId === card.id)}`}
            >
              <div
                className="transition-transform duration-200 ease-in-out"
                style={isLandCard(card) && card.is_tapped ? { transform: 'rotate(45deg)' } : undefined}
              >
                <MotionCard
                  card={{
                    id: card.id,
                    name: card.name,
                    image_url: card.cards?.image_url,
                    is_tapped: isLandCard(card) ? false : card.is_tapped,
                    damage_marked: card.damage_marked,
                    zone: card.zone,
                  }}
                  size={compact ? 'preview' : 'board'}
                  visualClassName=""
                  showNameFallback
                />
              </div>
              <p className="mt-2 truncate text-xs font-bold text-white [@media(max-height:760px)]:mt-1 [@media(max-height:760px)]:text-[10px]">
                {card.name}
              </p>
            </button>
          ))}
        </div>
      ) : (
        <div className={`rounded-md border border-dashed border-white/10 px-3 py-4 text-center text-xs font-semibold ${cockpitMutedClass}`}>
          No {title.toLowerCase()}.
        </div>
      )}
    </div>
  )
}

function ControllerActionPad({
  canPassPriority,
  isPassingPriority,
  onPassPriority,
  libraryCount,
  graveyardCount,
  stackCount,
  manaPool,
}: {
  canPassPriority: boolean
  isPassingPriority: boolean
  onPassPriority: () => void
  libraryCount: number
  graveyardCount: number
  stackCount: number
  manaPool: ManaPool
}) {
  const manaTotal = getManaPoolTotal(manaPool)

  return (
    <section className={`grid h-full min-h-0 grid-rows-[auto_auto_auto] gap-2 p-2 ${cockpitPanelClass}`}>
      <motion.button
        type="button"
        onClick={onPassPriority}
        disabled={!canPassPriority || isPassingPriority}
        whileHover={{ scale: canPassPriority ? 1.015 : 1 }}
        whileTap={{ scale: canPassPriority ? 0.97 : 1 }}
        className={`relative min-h-14 overflow-hidden px-3 py-2 text-center disabled:cursor-not-allowed ${
          canPassPriority
            ? `${priorityButtonClass} font-black uppercase`
            : `${cockpitButtonClass} font-bold opacity-50`
        }`}
      >
        <span className="relative z-10 block text-base [@media(max-height:760px)]:text-sm">
          {isPassingPriority ? 'Passing...' : canPassPriority ? 'Pass Priority' : 'Waiting'}
        </span>
        <span className="relative z-10 mt-0.5 block text-[9px] font-semibold uppercase tracking-[0.16em] opacity-80">
          {canPassPriority ? 'You have priority' : 'Priority is elsewhere'}
        </span>
        {canPassPriority ? (
          <motion.span
            className="pointer-events-none absolute inset-0 bg-amber-200/30"
            initial={{ scale: 0.86, opacity: 0.8 }}
            animate={{ scale: 1.08, opacity: 0 }}
            transition={{ repeat: Infinity, duration: 1.2 }}
          />
        ) : null}
      </motion.button>

      <div className="grid grid-cols-2 gap-1.5">
        <CockpitStatTile icon={Layers} label="Library" value={libraryCount} tone="cyan" />
        <CockpitStatTile icon={Skull} label="Graveyard" value={graveyardCount} tone="slate" />
        <CockpitStatTile icon={BookOpen} label="Stack" value={stackCount} tone="amber" />
        <CockpitStatTile icon={Zap} label="Mana" value={manaTotal} tone="emerald" />
      </div>
      <MiniManaPool manaPool={manaPool} />
    </section>
  )
}

function CockpitStatTile({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: LucideIcon
  label: string
  value: number
  tone: 'cyan' | 'slate' | 'amber' | 'emerald'
}) {
  const toneClass = getCockpitTileToneClass(tone)

  return (
    <div className={`flex items-center justify-between gap-2 rounded-md border p-1.5 px-2.5 ${toneClass}`}>
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 opacity-80" aria-hidden="true" />
        <p className="truncate text-[8px] font-black uppercase tracking-[0.14em] opacity-80">{label}</p>
      </div>
      <p className="text-sm font-black leading-none tabular-nums">{value}</p>
    </div>
  )
}

function MiniManaPool({ manaPool, compact = false }: { manaPool: ManaPool; compact?: boolean }) {
  return (
    <div className={`grid gap-1.5 ${compact ? 'grid-cols-3' : 'grid-cols-6'}`}>
      {manaColorsForDisplay.map((item) => (
        <div
          key={item.color}
          title={item.label}
          className={`relative aspect-square font-bold text-sm transition-all duration-300 ${getManaOrbClass(item.color, manaPool[item.color] ?? 0)}`}
        >
          <span className="absolute top-[18%] text-[9px] font-black leading-none opacity-80">{item.color}</span>
          <span className="absolute bottom-[16%] text-base font-black leading-none tabular-nums">{manaPool[item.color] ?? 0}</span>
        </div>
      ))}
    </div>
  )
}

function PlayDropZone({
  refCallback,
  selectedCard,
  canUseSorceryActions,
  isHandRaised,
}: {
  refCallback: (element: HTMLElement | null) => void
  selectedCard: ControllerCard | null
  canUseSorceryActions: boolean
  isHandRaised: boolean
}) {
  return (
    <motion.section
      ref={refCallback}
      layout
      initial={{ opacity: 0, y: 0 }}
      animate={{ opacity: 1, y: isHandRaised ? -12 : 0, scale: isHandRaised ? 1.08 : 1 }}
      className={`pointer-events-none absolute bottom-[9.75rem] left-6 right-6 z-10 mx-auto max-w-[34rem] px-6 py-3 text-center ${cockpitPanelClass}`}
    >
      <p className="text-xs font-black uppercase tracking-[0.18em] text-emerald-200 [@media(max-height:760px)]:text-[10px]">Play / Cast Zone</p>
      <p className={`mt-1 truncate text-xs [@media(max-height:760px)]:text-[10px] ${cockpitMutedClass}`}>
        Throw a hand card here
        {selectedCard ? `: ${selectedCard.name}` : ''}
      </p>
      {!canUseSorceryActions ? (
        <p className="mt-1 truncate text-[10px] text-amber-200">Needs your main phase, priority, and empty stack.</p>
      ) : null}
    </motion.section>
  )
}

function ControllerHandFan({
  cards,
  selectedCardId,
  swipeCastingCardId,
  isRaised,
  handContainerRef,
  onSelect,
  onRaiseChange,
  onReorder,
  onSwipeCast,
  onPreviewStart,
  onPreviewEnd,
}: {
  cards: ControllerCard[]
  selectedCardId?: string
  swipeCastingCardId?: string | null
  isRaised: boolean
  handContainerRef: React.RefObject<HTMLDivElement | null>
  onSelect: (cardId: string) => void
  onRaiseChange: (isRaised: boolean) => void
  onReorder: (cardId: string, direction: -1 | 1) => void
  onSwipeCast: (card: ControllerCard, info: PanInfo) => void
  onPreviewStart: (card: ControllerCard) => void
  onPreviewEnd: () => void
}) {
  return (
    <motion.div
      ref={handContainerRef}
      layout={false}
      onPointerDown={() => onRaiseChange(true)}
      className="relative z-[90] flex h-[19rem] w-full -translate-x-6 items-end overflow-visible [@media(max-height:760px)]:h-[12.5rem]"
    >
      <motion.div
        layout={false}
        animate={{ y: isRaised ? 50 : 120 }}
        transition={{ type: 'spring', stiffness: 280, damping: 28 }}
        className="relative z-10 flex h-[19rem] min-w-full items-end justify-center overflow-visible [@media(max-height:760px)]:h-[12.5rem]"
      >
      <AnimatePresence initial={false}>
        {cards.map((card, index) => {
          const isSelected = selectedCardId === card.id
          const cardWidthClass = getHandFanCardWidth(cards.length)

          return (
            <HandCardDragItem
              key={card.id}
              card={card}
              cardWidthClass={cardWidthClass}
              index={index}
              cardCount={cards.length}
              isSelected={isSelected}
              isCasting={swipeCastingCardId === card.id}
              isHandRaised={isRaised}
              onSelect={onSelect}
              onRaiseChange={onRaiseChange}
              onReorder={onReorder}
              onSwipeCast={onSwipeCast}
              onPreviewStart={onPreviewStart}
              onPreviewEnd={onPreviewEnd}
            />
          )
        })}
      </AnimatePresence>
      </motion.div>
    </motion.div>
  )
}

function HandCardDragItem({
  card,
  cardWidthClass,
  index,
  cardCount,
  isSelected,
  isCasting,
  isHandRaised,
  onSelect,
  onRaiseChange,
  onReorder,
  onSwipeCast,
  onPreviewStart,
  onPreviewEnd,
}: {
  card: ControllerCard
  cardWidthClass: string
  index: number
  cardCount: number
  isSelected: boolean
  isCasting: boolean
  isHandRaised: boolean
  onSelect: (cardId: string) => void
  onRaiseChange: (isRaised: boolean) => void
  onReorder: (cardId: string, direction: -1 | 1) => void
  onSwipeCast: (card: ControllerCard, info: PanInfo) => void
  onPreviewStart: (card: ControllerCard) => void
  onPreviewEnd: () => void
}) {
  const dragControls = useDragControls()
  const [dragNonce, setDragNonce] = useState(0)
  const midIndex = (cardCount - 1) / 2
  const rotationAngle = (index - midIndex) * 4
  const yOffset = Math.abs(index - midIndex) * 2

  return (
    <motion.div
      layout={false}
      key={`${card.id}:${dragNonce}`}
      role="button"
      tabIndex={0}
      drag
      dragControls={dragControls}
      dragListener={false}
      dragConstraints={{ top: -320, right: 140, bottom: 0, left: -140 }}
      dragElastic={0.22}
      dragMomentum={false}
      onPointerDown={(event) => {
        onRaiseChange(true)
        onSelect(card.id)
        onPreviewStart(card)
        dragControls.start(event)
      }}
      onPointerUp={onPreviewEnd}
      onPointerLeave={onPreviewEnd}
      onPointerCancel={onPreviewEnd}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          onSelect(card.id)
        }
      }}
      onDragEnd={(_, info) => {
        onPreviewEnd()
        setDragNonce((current) => current + 1)

        if (Math.abs(info.offset.x) > 72 && Math.abs(info.offset.y) < 120) {
          onReorder(card.id, info.offset.x > 0 ? 1 : -1)
          return
        }

        onSwipeCast(card, info)
      }}
      initial={{ opacity: 0, y: 40 }}
      animate={{
        opacity: isCasting ? 0.55 : 1,
        y: isSelected && isHandRaised ? -24 : yOffset,
        rotate: isSelected ? 0 : rotationAngle,
        scale: isSelected ? 1.08 : 0.95,
        zIndex: isSelected ? 140 : 100 + index,
      }}
      exit={{ opacity: 0, y: 40 }}
      whileDrag={{ scale: 1.12, rotate: 0, zIndex: 999, cursor: 'grabbing' }}
      whileHover={{
        y: -50,
        rotate: 0,
        scale: 1.1,
        transition: { type: 'spring', stiffness: 300, damping: 20 },
      }}
      className={`relative shrink-0 origin-bottom cursor-grab touch-none select-none active:cursor-grabbing ${isSelected ? 'drop-shadow-[0_0_18px_rgba(103,232,249,0.32)]' : ''} ${getHandOverlapClass(cardCount)} ${cardWidthClass}`}
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
        size="preview"
        visualClassName=""
      />
    </motion.div>
  )
}

function SelectedCardDock({
  card,
  playerId,
  sessionId,
  isSessionFinished,
  sessionPlayers,
  stackItems,
  canUseInstantActions,
  canUseSorceryActions,
  requiresTarget,
  isTargeting,
  selectedTargetName,
  selectedTargetId,
  isCastingTargetedSpell,
  onStartTargeting,
  onCancelTargeting,
  onConfirmTargetedCast,
  landsPlayedThisTurn,
  landPlayLimit,
  onPreviewStart,
  onPreviewEnd,
}: {
  card: ControllerCard | null
  playerId: string | null
  sessionId: string
  isSessionFinished: boolean
  sessionPlayers: GameSessionPlayer[]
  stackItems: StackItem[]
  canUseInstantActions: boolean
  canUseSorceryActions: boolean
  requiresTarget: boolean
  isTargeting: boolean
  selectedTargetName: string | null
  selectedTargetId: string | null
  isCastingTargetedSpell: boolean
  onStartTargeting: () => void
  onCancelTargeting: () => void
  onConfirmTargetedCast: () => void
  landsPlayedThisTurn: number
  landPlayLimit: number
  onPreviewStart: (card: ControllerCard) => void
  onPreviewEnd: () => void
}) {
  const [isExpanded, setIsExpanded] = useState(false)

  useEffect(() => {
    if (card?.id) {
      setIsExpanded(true)
    }
  }, [card?.id])

  if (!card) {
    return null
  }

  const powerToughness = getPowerToughnessLabel(card)
  const keywords = card.zone === 'battlefield' ? getSupportedKeywordLabels(card) : []

  return (
    <motion.section
      layout={false}
      initial={false}
      animate={{ height: '100%' }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      className={`relative z-[150] h-full w-full overflow-hidden p-2 ${cockpitPanelStrongClass}`}
    >
      <button
        type="button"
        onClick={() => setIsExpanded((current) => !current)}
        className="grid h-12 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md px-3 text-left transition-colors hover:bg-white/[0.055]"
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-black text-white">{card.name}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!isExpanded ? (
            <span className={`${getCockpitBadgeClass('emerald')} text-[10px] font-black uppercase`}>
              Cast / Tap
            </span>
          ) : null}
          <span className={`${getCockpitBadgeClass('cyan')} px-2 py-1 text-xs font-bold`}>
            {card.zone}
          </span>
        </div>
      </button>

      <AnimatePresence initial={false}>
        {isExpanded ? (
          <motion.div
            key="selected-card-expanded"
            initial={{ height: 0, opacity: 0, y: 18 }}
            animate={{ height: 'auto', opacity: 1, y: 0 }}
            exit={{ height: 0, opacity: 0, y: 12 }}
            transition={{ type: 'spring', stiffness: 330, damping: 32 }}
            className="min-h-0 overflow-auto p-3 [@media(max-height:760px)]:p-2"
          >
            {isTargeting ? (
              <div className="grid h-full content-between gap-3 p-2">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-[0.2em] text-red-200">
                    Select a target on the stack
                  </p>
                  <p className="mt-2 truncate text-sm font-bold text-white">
                    {selectedTargetName ? `Target: ${selectedTargetName}` : 'No target selected'}
                  </p>
                </div>
                <div className="grid grid-cols-[1fr_auto] gap-2">
                  <button
                    type="button"
                    disabled={!selectedTargetId || isCastingTargetedSpell}
                    onClick={onConfirmTargetedCast}
                    className="rounded-md bg-red-300 px-3 py-2 text-sm font-black uppercase tracking-[0.12em] text-red-950 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {isCastingTargetedSpell
                      ? 'Casting...'
                      : selectedTargetId
                        ? 'Confirm Cast'
                        : 'Choose Target'}
                  </button>
                  <button
                    type="button"
                    onClick={onCancelTargeting}
                    className={`${cockpitButtonClass} px-3 py-2 text-xs font-bold uppercase`}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
            <div className="flex min-h-0 gap-3">
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
                interactive
                className="w-24 shrink-0 [@media(max-height:760px)]:w-20"
                visualClassName=""
                showNameFallback
                onPointerDown={() => onPreviewStart(card)}
                onPointerUp={onPreviewEnd}
                onPointerLeave={onPreviewEnd}
                onPointerCancel={onPreviewEnd}
              />
              <div className="min-w-0 flex-1 overflow-auto p-2">
                <div className="mb-2 min-w-0">
                  <p className="line-clamp-1 text-base font-black leading-tight text-white [@media(max-height:760px)]:text-sm">{card.name}</p>
                  {card.cards?.type_line ? (
                    <p className={`mt-1 line-clamp-1 text-xs font-medium leading-snug ${cockpitMutedClass}`}>{card.cards.type_line}</p>
                  ) : null}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {card.cards?.mana_cost ? (
                      <span className={`${getCockpitBadgeClass('slate')} text-xs font-semibold`}>
                        {card.cards.mana_cost}
                      </span>
                    ) : null}
                    {powerToughness ? (
                      <span className={`${getCockpitBadgeClass('slate')} text-xs font-semibold`}>
                        {powerToughness}
                      </span>
                    ) : null}
                    {card.is_tapped ? (
                      <span className={`${getCockpitBadgeClass('amber')} text-xs font-semibold`}>
                        Tapped
                      </span>
                    ) : null}
                    {card.damage_marked > 0 ? (
                      <span className={`${getCockpitBadgeClass('red')} text-xs font-semibold`}>
                        Damage {card.damage_marked}
                      </span>
                    ) : null}
                    {keywords.slice(0, 3).map((label) => (
                      <span
                        key={label}
                        className={`${getCockpitBadgeClass('cyan')} text-[10px]`}
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                </div>
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
                {requiresTarget && card.zone === 'hand' ? (
                  <button
                    type="button"
                    disabled={!canUseInstantActions}
                    onClick={onStartTargeting}
                    className="mt-2 w-full rounded-md bg-red-300 px-3 py-2 text-sm font-black uppercase tracking-[0.12em] text-red-950 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    Select Target
                  </button>
                ) : null}
                {playerId && !requiresTarget ? (
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
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.section>
  )
}

function getHandFanCardWidth(cardCount: number) {
  if (cardCount <= 4) {
    return 'w-28 [@media(max-height:760px)]:w-20'
  }

  if (cardCount <= 7) {
    return 'w-24 [@media(max-height:760px)]:w-[4.5rem]'
  }

  return 'w-20 [@media(max-height:760px)]:w-16'
}

function getHandOverlapClass(cardCount: number) {
  if (cardCount <= 4) {
    return '-mx-3 [@media(max-height:760px)]:-mx-2'
  }

  if (cardCount <= 7) {
    return '-mx-4 [@media(max-height:760px)]:-mx-3'
  }

  return '-mx-6 [@media(max-height:760px)]:-mx-4'
}

function ControllerCombatTargets({
  canDeclareAttackers,
  attackUnavailableReason,
  defendingPlayers,
  canDeclareBlockers,
  blockUnavailableReason,
  blockableAssignments,
  registerAttackTargetRef,
  registerBlockTargetRef,
  compact = false,
}: {
  canDeclareAttackers: boolean
  attackUnavailableReason?: string | null
  defendingPlayers: GameSessionPlayer[]
  canDeclareBlockers: boolean
  blockUnavailableReason?: string | null
  blockableAssignments: CombatAssignment[]
  registerAttackTargetRef: (playerId: string, element: HTMLElement | null) => void
  registerBlockTargetRef: (attackerCardId: string, element: HTMLElement | null) => void
  compact?: boolean
}) {
  const shouldShowAttackTargets = canDeclareAttackers || attackUnavailableReason
  const shouldShowBlockTargets = canDeclareBlockers || blockUnavailableReason

  if (!shouldShowAttackTargets && !shouldShowBlockTargets) {
    return null
  }

  return (
    <section className={compact ? `h-full overflow-hidden p-3 ${cockpitSoftPanelClass}` : `mb-5 p-4 ${cockpitPanelClass}`}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-black text-white">Combat</h2>
          <p className={`text-xs ${cockpitMutedClass}`}>Drag creatures to targets.</p>
        </div>
        {canDeclareBlockers ? (
          <span className={`${getCockpitBadgeClass('red')} text-xs font-semibold`}>
            Defend: {blockableAssignments.length} incoming
          </span>
        ) : null}
      </div>

      {shouldShowAttackTargets ? (
        <div className="mb-3">
          <p className="mb-2 text-xs font-black uppercase tracking-[0.14em] text-red-200">
            Attack Targets
          </p>
          <div className={compact ? 'grid gap-2' : 'grid grid-cols-3 gap-2'}>
            {defendingPlayers.length > 0 ? (
              defendingPlayers.map((player) => (
                <div
                  key={player.player_id}
                  ref={(element) => registerAttackTargetRef(player.player_id, element)}
                  className={`${compact ? 'p-2' : 'p-3'} rounded-md border transition-colors ${
                    canDeclareAttackers
                      ? 'border-red-300/25 bg-red-500/10'
                      : 'border-white/10 bg-white/[0.045] opacity-60'
                  }`}
                >
                  <p className="text-xs font-black uppercase tracking-[0.12em] text-red-100">P{player.seat_number}</p>
                  <p className="truncate text-sm font-bold text-white">
                    {player.username || `Player ${player.player_id.slice(0, 8)}`}
                  </p>
                  <p className={compact ? 'text-xl font-black text-red-100' : 'text-2xl font-black text-red-100'}>{player.life_total}</p>
                </div>
              ))
            ) : (
              <p className={`col-span-3 text-xs ${cockpitMutedClass}`}>No defending players.</p>
            )}
          </div>
          {!canDeclareAttackers && attackUnavailableReason ? (
            <p className={`mt-2 text-xs ${cockpitMutedClass}`}>{attackUnavailableReason}</p>
          ) : null}
        </div>
      ) : null}

      {shouldShowBlockTargets ? (
        <div>
          <p className="mb-2 text-xs font-black uppercase tracking-[0.14em] text-red-200">
            Incoming Attackers
          </p>
          <div className="grid gap-2">
            {blockableAssignments.length > 0 ? (
              blockableAssignments.map((assignment) => (
                <div
                  key={assignment.id}
                  ref={(element) => registerBlockTargetRef(assignment.attacker_card_id, element)}
                  className={`rounded-md border p-3 transition-colors ${
                    canDeclareBlockers
                      ? 'border-red-300/25 bg-red-500/10'
                      : 'border-white/10 bg-white/[0.045] opacity-60'
                  }`}
                >
                  <p className="truncate text-sm font-bold text-white">{assignment.attacker_name}</p>
                  <p className={`text-xs ${cockpitMutedClass}`}>
                    From {assignment.attacking_username} to {assignment.defending_username}
                  </p>
                </div>
              ))
            ) : (
              <p className={`text-xs ${cockpitMutedClass}`}>No attackers are attacking you.</p>
            )}
          </div>
          {!canDeclareBlockers && blockUnavailableReason ? (
            <p className={`mt-2 text-xs ${cockpitMutedClass}`}>{blockUnavailableReason}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function getSwipeCastEligibility({
  card,
  isSessionFinished,
  canUseSorceryActions,
  landsPlayedThisTurn,
  landPlayLimit,
}: {
  card: ControllerCard
  isSessionFinished: boolean
  canUseSorceryActions: boolean
  landsPlayedThisTurn: number
  landPlayLimit: number
}) {
  if (isSessionFinished) {
    return { canCast: false, reason: 'Game is finished.' }
  }

  const normalizedTypeLine = card.cards?.type_line?.toLowerCase() ?? ''

  if (normalizedTypeLine.includes('instant') || normalizedTypeLine.includes('sorcery')) {
    return { canCast: false, reason: 'Use spell controls for instant and sorcery cards.' }
  }

  const parsedManaCost = parseManaCost(card.cards?.mana_cost)

  if (parsedManaCost.generic > 0) {
    return { canCast: false, reason: 'Generic mana choice is required.' }
  }

  if (normalizedTypeLine.includes('land')) {
    const resolvedLandPlayLimit = Math.max(1, landPlayLimit)
    const landPlaysRemaining = resolvedLandPlayLimit - Math.min(landsPlayedThisTurn, resolvedLandPlayLimit)

    if (!canUseSorceryActions || landPlaysRemaining <= 0) {
      return { canCast: false, reason: 'Land play is not available right now.' }
    }
  }

  if (!canUseSorceryActions) {
    return { canCast: false, reason: 'Casting requires your main phase, priority, and an empty stack.' }
  }

  return { canCast: true, reason: null }
}

function updateElementRefMap(
  elements: Map<string, HTMLElement>,
  id: string,
  element: HTMLElement | null,
) {
  const currentElement = elements.get(id) ?? null

  if (currentElement === element) {
    return
  }

  if (element) {
    elements.set(id, element)
  } else {
    elements.delete(id)
  }
}

function isPointInElement(info: PanInfo, element: HTMLElement | null) {
  if (!element) {
    return false
  }

  const rect = element.getBoundingClientRect()

  return (
    info.point.x >= rect.left &&
    info.point.x <= rect.right &&
    info.point.y >= rect.top &&
    info.point.y <= rect.bottom
  )
}

function isCreatureCard(card: ControllerCard) {
  return (card.cards?.type_line ?? '').toLowerCase().includes('creature')
}

function getPowerToughnessLabel(card: ControllerCard) {
  const linkedCard = card.cards

  if (!linkedCard || !isCreatureCard(card)) {
    return null
  }

  if (linkedCard.power_toughness) {
    return linkedCard.power_toughness
  }

  if (linkedCard.power !== null && linkedCard.power !== undefined) {
    return `${linkedCard.power}/${linkedCard.toughness ?? '?'}`
  }

  return null
}

function cardHasPrintedOrCopiedKeyword(card: ControllerCard, keyword: string) {
  const normalizedKeyword = normalizeKeyword(keyword)
  const printedKeywords = card.cards?.keywords ?? []

  if (printedKeywords.some((printedKeyword) => normalizeKeyword(printedKeyword) === normalizedKeyword)) {
    return true
  }

  const printedEffects = card.cards?.script?.continuous_effects ?? []
  const copiedEffects = card.copied_script?.continuous_effects ?? []
  const effects = copiedEffects.length > 0 ? copiedEffects : printedEffects

  return effects.some((effect) => {
    const effectType = effect.type ?? effect.effect_type
    return normalizeKeyword(effectType) === normalizedKeyword
  })
}

function getSupportedKeywordLabels(card: ControllerCard) {
  return [
    ['haste', 'Haste'],
    ['vigilance', 'Vigilance'],
    ['trample', 'Trample'],
    ['indestructible', 'Indestructible'],
    ['first_strike', 'First strike'],
    ['double_strike', 'Double strike'],
  ]
    .filter(([keyword]) => cardHasPrintedOrCopiedKeyword(card, keyword))
    .map(([, label]) => label)
}

function normalizeKeyword(keyword: string | undefined) {
  return (keyword ?? '').toLowerCase().replace(/[\s-]+/g, '_')
}

function getAttackUnavailableReason({
  combatActionState,
  defendingPlayers,
  isSessionFinished,
}: {
  combatActionState: CombatActionState | null
  defendingPlayers: GameSessionPlayer[]
  isSessionFinished: boolean
}) {
  if (isSessionFinished) {
    return 'Game is finished.'
  }

  if (defendingPlayers.length === 0) {
    return 'No defending players available.'
  }

  if (!combatActionState) {
    return 'Checking combat permissions...'
  }

  if (!combatActionState.can_declare_attackers) {
    return combatActionState.reason ?? 'Attack is not available right now.'
  }

  return null
}

function getBlockUnavailableReason({
  combatActionState,
  blockableAssignments,
  isSessionFinished,
}: {
  combatActionState: CombatActionState | null
  blockableAssignments: CombatAssignment[]
  isSessionFinished: boolean
}) {
  if (isSessionFinished) {
    return 'Game is finished.'
  }

  if (!combatActionState) {
    return 'Checking combat permissions...'
  }

  if (!combatActionState.can_declare_blockers) {
    return combatActionState.block_reason ?? 'Block is not available right now.'
  }

  if (blockableAssignments.length === 0) {
    return 'No attackers are attacking you.'
  }

  return null
}

function isCombatInteractionStep(step: string | undefined) {
  if (!step) {
    return false
  }

  const normalizedStep = String(step).toLowerCase()

  return normalizedStep.includes('attack') || normalizedStep.includes('block')
}

function doesCardRequireStackTarget(card: ControllerCard) {
  const typeLine = card.cards?.type_line?.toLowerCase() || ''
  const linkedCardWithText = card.cards as ({ oracle_text?: string | null } & NonNullable<ControllerCard['cards']>) | null
  const text = linkedCardWithText?.oracle_text?.toLowerCase() || ''
  const actions = card.cards?.script?.actions ?? []
  const copiedActions = card.copied_script?.actions ?? []
  const allActions = copiedActions.length > 0 ? copiedActions : actions
  const hasTargetText =
    (typeLine.includes('instant') || typeLine.includes('sorcery')) &&
    text.includes('target')
  const hasStackTargetAction = allActions.some((action) => {
    const actionType = normalizeKeyword(action.type)
    return (
      action.target === 'spell' ||
      action.target_type === 'spell' ||
      actionType === 'counter_spell' ||
      actionType === 'counter_target_spell'
    )
  })

  return hasTargetText || hasStackTargetAction
}

function formatStackTargetLabel(item: StackItem | null) {
  if (!item) {
    return 'Unknown target'
  }

  const payloadLabel =
    typeof item.payload.target_stack_label === 'string'
      ? item.payload.target_stack_label
      : null

  return item.source_card_name ?? payloadLabel ?? item.action_type
}

function getManaPoolTotal(manaPool: ManaPool) {
  return manaColorsForDisplay.reduce((total, item) => total + (manaPool[item.color] ?? 0), 0)
}

function getPreviewCardImageUrl(card: ControllerCard | BoardCard) {
  return 'cards' in card ? card.cards?.image_url ?? null : card.image_url
}

function getManaOrbClass(color: ManaColor, value: number) {
  const isActive = value > 0
  const toneClass = {
    W: 'border-yellow-100/40 bg-yellow-50 text-slate-950',
    U: 'border-cyan-200/35 bg-cyan-500/18 text-cyan-50',
    B: 'border-fuchsia-200/25 bg-fuchsia-950/45 text-fuchsia-100',
    R: 'border-red-200/35 bg-red-500/18 text-red-50',
    G: 'border-emerald-200/35 bg-emerald-500/18 text-emerald-50',
    C: 'border-slate-200/25 bg-slate-500/18 text-slate-100',
  }[color]

  return `flex items-center justify-center rounded-full border shadow-inner ${toneClass} ${isActive ? 'font-black shadow-white/10' : 'opacity-45'}`
}

function isLandCard(card: ControllerCard) {
  return card.cards?.type_line?.toLowerCase().includes('land') ?? false
}

function isBoardLandCard(card: BoardCard) {
  return card.type_line?.toLowerCase().includes('land') ?? false
}
