// components/ControllerList.tsx
'use client'
import Image from 'next/image'
import { AnimatePresence, motion, useDragControls, type PanInfo } from 'framer-motion'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  castCardFromHand,
  declareAttacker,
  declareBlocker,
  getErrorMessage,
  passPriority,
} from '@/lib/game/actions'
import { enableFallbackRefresh, showDevControls } from '@/lib/game/dev'
import { parseManaCost } from '@/lib/game/mana'
import {
  getCombatActionState,
  getCombatAssignments,
  getControllerCards,
  getCurrentPlayerId,
  getGameSession,
  getGameSessionPlayers,
  getStackItems,
  getTurnState,
} from '@/lib/game/data'
import type {
  CombatActionState,
  CombatAssignment,
    ControllerCard,
    GameSessionPlayer,
    GameTurnState,
    StackItem,
  } from '@/lib/game/types'
import CardController from './CardController'
import ActionButtons from './ActionButtons'
import CardZoneControls from './CardZoneControls'
import PlayerActionPanel from './PlayerActionPanel'
import StaticEffectControls from './StaticEffectControls'
import DevAdminPanel from './DevAdminPanel'
import MotionCard from './MotionCard'

export default function ControllerList({ sessionId }: { sessionId: string }) {
  const [cards, setCards] = useState<ControllerCard[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [lastFetchInfo, setLastFetchInfo] = useState<string | null>(null)
  const [playerId, setPlayerId] = useState<string | null>(null)
  const [combatActionState, setCombatActionState] = useState<CombatActionState | null>(null)
  const [combatAssignments, setCombatAssignments] = useState<CombatAssignment[]>([])
  const [isSessionFinished, setIsSessionFinished] = useState(false)
  const [sessionPlayers, setSessionPlayers] = useState<GameSessionPlayer[]>([])
  const [turnState, setTurnState] = useState<GameTurnState | null>(null)
  const [stackItems, setStackItems] = useState<StackItem[]>([])
  const [pendingStackCount, setPendingStackCount] = useState(0)
  const [declaringAttackerId, setDeclaringAttackerId] = useState<string | null>(null)
  const [declaringBlockerId, setDeclaringBlockerId] = useState<string | null>(null)
  const [draftedCardId, setDraftedCardId] = useState<string | null>(null)
  const [swipeCastingCardId, setSwipeCastingCardId] = useState<string | null>(null)
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null)
  const [isPassingPriority, setIsPassingPriority] = useState(false)
  const [isHandRaised, setIsHandRaised] = useState(false)
  const [handOrder, setHandOrder] = useState<string[]>([])
  const handContainerRef = useRef<HTMLDivElement | null>(null)
  const attackTargetElements = useRef(new Map<string, HTMLElement>())
  const blockTargetElements = useRef(new Map<string, HTMLElement>())
  const playDropZoneRef = useRef<HTMLElement | null>(null)
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    let isMounted = true
    let currentPlayerId: string | null = null

    const fetchPlayer = async () => {
      const resolvedPlayerId = await getCurrentPlayerId(supabase)
      if (isMounted) {
        setPlayerId(resolvedPlayerId)
      }

      return resolvedPlayerId
    }

    const fetchCards = async (currentPlayerId: string) => {
      setErrorMessage(null)

      try {
        const result = await getControllerCards(supabase, sessionId, currentPlayerId)
        if (isMounted) {
          setCards(result.cards)
          setLastFetchInfo(
            result.missingCardIds.length > 0
              ? `Session ${sessionId}: ${result.rowCount} card(s) loaded, ${result.missingCardIds.length} card id(s) not found in cards`
              : `Session ${sessionId}: ${result.rowCount} card(s) loaded`,
          )
        }

        console.log('Controller cards loaded:', {
          sessionId,
          count: result.rowCount,
          cards: result.cards,
          missingCardIds: result.missingCardIds,
        })
      } catch (error) {
        console.error('Failed to fetch controller cards:', error)
        if (isMounted) {
          setErrorMessage(error instanceof Error ? error.message : 'Could not load controller cards')
          setCards([])
        }
      }

      if (isMounted) {
        setIsLoading(false)
      }
    }

    const loadControllerCards = async () => {
      try {
        currentPlayerId = currentPlayerId ?? (await fetchPlayer())

        if (!currentPlayerId) {
          if (isMounted) {
            setCards([])
            setLastFetchInfo(`Session ${sessionId}: no signed-in player found`)
            setIsLoading(false)
          }
          return
        }

        await fetchCards(currentPlayerId)
      } catch (error) {
        console.error('Failed to initialize controller cards:', error)
        if (isMounted) {
          setErrorMessage(error instanceof Error ? error.message : 'Could not load controller cards')
          setCards([])
          setIsLoading(false)
        }
      }
    }

    const loadGameContext = async () => {
      try {
        const [
          session,
          nextCombatActionState,
          nextCombatAssignments,
          nextSessionPlayers,
          nextStackItems,
          nextTurnState,
        ] = await Promise.all([
          getGameSession(supabase, sessionId),
          getCombatActionState(supabase, sessionId),
          getCombatAssignments(supabase, sessionId),
          getGameSessionPlayers(supabase, sessionId),
          getStackItems(supabase, sessionId),
          getTurnState(supabase, sessionId),
        ])

        if (isMounted) {
          setIsSessionFinished(session?.status === 'finished')
            setCombatActionState(nextCombatActionState)
            setCombatAssignments(nextCombatAssignments)
            setSessionPlayers(nextSessionPlayers)
            setStackItems(nextStackItems)
            setPendingStackCount(nextStackItems.filter((item) => item.status === 'pending').length)
            setTurnState(nextTurnState)
        }
      } catch (error) {
        const message = getErrorMessage(error)
        console.error('Failed to load controller game context:', message, error)
        if (isMounted) {
          setErrorMessage(message)
        }
      }
    }

    loadControllerCards()
    loadGameContext()

    const channel = supabase
      .channel(`controller:${sessionId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_cards',
          filter: `session_id=eq.${sessionId}`,
        },
        () => {
          if (currentPlayerId) {
            fetchCards(currentPlayerId)
          }
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'cards',
        },
        () => {
          if (currentPlayerId) {
            fetchCards(currentPlayerId)
          }
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_sessions',
          filter: `id=eq.${sessionId}`,
        },
        loadGameContext,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_stack_items',
          filter: `session_id=eq.${sessionId}`,
        },
        loadGameContext,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_turn_state',
          filter: `session_id=eq.${sessionId}`,
        },
        loadGameContext,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_combat_assignments',
          filter: `session_id=eq.${sessionId}`,
        },
        loadGameContext,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_combat_blockers',
          filter: `session_id=eq.${sessionId}`,
        },
        loadGameContext,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'game_session_players',
          filter: `session_id=eq.${sessionId}`,
        },
        loadGameContext,
      )
      .subscribe((status, error) => {
        console.log('Controller realtime status:', status)
        if (error) {
          console.error('Controller realtime error:', error)
        }
      })

    const refreshInterval = enableFallbackRefresh
      ? window.setInterval(() => {
          if (currentPlayerId) {
            fetchCards(currentPlayerId)
          }
          loadGameContext()
        }, 2000)
      : null

    return () => {
      isMounted = false
      if (refreshInterval) {
        window.clearInterval(refreshInterval)
      }
      supabase.removeChannel(channel)
    }
  }, [sessionId, supabase])

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

  const registerAttackTargetRef = useCallback((playerId: string, element: HTMLElement | null) => {
    updateElementRefMap(attackTargetElements.current, playerId, element)
  }, [])

  const registerBlockTargetRef = useCallback((attackerCardId: string, element: HTMLElement | null) => {
    updateElementRefMap(blockTargetElements.current, attackerCardId, element)
  }, [])

  if (isLoading) {
    return <p className="text-slate-400">Loading cards...</p>
  }

  if (errorMessage) {
    return (
      <div className="rounded-lg bg-red-950 p-4 text-sm text-red-100">
        Could not load cards: {errorMessage}
      </div>
    )
  }

  const handCards = cards.filter((card) => card.zone === 'hand')
  const orderedHandCards = orderCardsByIds(handCards, handOrder)
  const battlefieldCards = cards.filter((card) => card.zone === 'battlefield')
  const draftedCard = draftedCardId ? cards.find((card) => card.id === draftedCardId) ?? null : null
  const selectedCard =
    (selectedCardId ? cards.find((card) => card.id === selectedCardId) : null) ??
    draftedCard ??
    handCards[0] ??
    battlefieldCards[0] ??
    null
  const currentPlayer = sessionPlayers.find((player) => player.player_id === playerId) ?? null
  const opponentPlayers = sessionPlayers.filter((player) => player.player_id !== playerId)
  const libraryCount = cards.filter((card) => card.zone === 'library').length
  const tappedBattlefieldCount = battlefieldCards.filter((card) => card.is_tapped).length
  const defendingPlayers = sessionPlayers.filter((player) => player.player_id !== playerId)
  const attackUnavailableReason = getAttackUnavailableReason({
    combatActionState,
    defendingPlayers,
    isSessionFinished,
  })
  const canDeclareAttackers = !attackUnavailableReason
  const blockableAssignments = combatAssignments.filter(
    (assignment) => assignment.defending_player_id === playerId,
  )
  const blockUnavailableReason = getBlockUnavailableReason({
    combatActionState,
    blockableAssignments,
    isSessionFinished,
  })
  const canDeclareBlockers = !blockUnavailableReason
  const canUseInstantActions = Boolean(
    !isSessionFinished &&
      playerId &&
      combatActionState?.priority_player_id &&
      combatActionState.priority_player_id === playerId,
  )
  const canUseSorceryActions = Boolean(
    canUseInstantActions &&
      playerId &&
      combatActionState?.active_player_id === playerId &&
      (combatActionState?.step === 'precombat_main' ||
        combatActionState?.step === 'postcombat_main') &&
      pendingStackCount === 0,
  )

  const refreshControllerData = async () => {
    if (playerId) {
      const result = await getControllerCards(supabase, sessionId, playerId)
      setCards(result.cards)
      setLastFetchInfo(
        result.missingCardIds.length > 0
          ? `Session ${sessionId}: ${result.rowCount} card(s) loaded, ${result.missingCardIds.length} card id(s) not found in cards`
          : `Session ${sessionId}: ${result.rowCount} card(s) loaded`,
      )
    }

    const [
      session,
      nextCombatActionState,
      nextCombatAssignments,
      nextSessionPlayers,
      nextStackItems,
      nextTurnState,
    ] = await Promise.all([
      getGameSession(supabase, sessionId),
      getCombatActionState(supabase, sessionId),
      getCombatAssignments(supabase, sessionId),
      getGameSessionPlayers(supabase, sessionId),
      getStackItems(supabase, sessionId),
      getTurnState(supabase, sessionId),
    ])

    setIsSessionFinished(session?.status === 'finished')
      setCombatActionState(nextCombatActionState)
      setCombatAssignments(nextCombatAssignments)
      setSessionPlayers(nextSessionPlayers)
      setStackItems(nextStackItems)
      setPendingStackCount(nextStackItems.filter((item) => item.status === 'pending').length)
      setTurnState(nextTurnState)
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
      await castCardFromHand(supabase, sessionId, card.id)
      setDraftedCardId(null)
      if (playerId) {
        const result = await getControllerCards(supabase, sessionId, playerId)
        setCards(result.cards)
      }
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

  const handleCombatDragEnd = (card: ControllerCard, info: PanInfo) => {
    if (card.zone !== 'battlefield') {
      return
    }

    if (canDeclareAttackers && onBoardPoint(info, attackTargetElements.current)) {
      const targetPlayerId = getElementHitId(info, attackTargetElements.current)
      if (targetPlayerId) {
        handleDeclareAttacker(card.id, targetPlayerId)
      }
      return
    }

    if (canDeclareBlockers && onBoardPoint(info, blockTargetElements.current)) {
      const attackerCardId = getElementHitId(info, blockTargetElements.current)
      if (attackerCardId) {
        handleDeclareBlocker(card.id, attackerCardId)
      }
    }
  }

  const handleDeclareAttacker = async (attackerCardId: string, defendingPlayerId: string) => {
    setErrorMessage(null)
    setDeclaringAttackerId(attackerCardId)

    try {
      await declareAttacker(supabase, sessionId, attackerCardId, defendingPlayerId)
      if (playerId) {
        const result = await getControllerCards(supabase, sessionId, playerId)
        setCards(result.cards)
      }
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to declare attacker:', message, error)
      setErrorMessage(message)
    } finally {
      setDeclaringAttackerId(null)
    }
  }

  const handleDeclareBlocker = async (blockerCardId: string, attackerCardId: string) => {
    setErrorMessage(null)
    setDeclaringBlockerId(blockerCardId)

    try {
      await declareBlocker(supabase, sessionId, blockerCardId, attackerCardId)
      if (playerId) {
        const [result, nextAssignments, nextActionState] = await Promise.all([
          getControllerCards(supabase, sessionId, playerId),
          getCombatAssignments(supabase, sessionId),
          getCombatActionState(supabase, sessionId),
        ])
        setCards(result.cards)
        setCombatAssignments(nextAssignments)
        setCombatActionState(nextActionState)
      }
    } catch (error) {
      const message = getErrorMessage(error)
      console.error('Failed to declare blocker:', message, error)
      setErrorMessage(message)
    } finally {
      setDeclaringBlockerId(null)
    }
  }

  return (
    <div className="relative h-[100svh] overflow-hidden p-3 landscape:h-screen">
      <div className="pointer-events-none absolute inset-0 opacity-40">
        <div className="absolute left-10 top-20 h-px w-44 rotate-[-28deg] bg-cyan-200/30" />
        <div className="absolute bottom-12 left-1/2 h-32 w-[34rem] -translate-x-1/2 rounded-[100%] border-t border-cyan-200/25 bg-cyan-400/10 blur-sm" />
        <div className="absolute -bottom-24 left-1/2 h-72 w-[48rem] -translate-x-1/2 rounded-[100%] bg-cyan-500/10 blur-3xl" />
      </div>
      {lastFetchInfo && showDevControls ? <p className="mb-3 text-xs text-slate-500">{lastFetchInfo}</p> : null}
      <div className="relative z-10 grid h-[calc(100svh-1.5rem)] grid-cols-[12rem_minmax(0,1fr)_20rem] gap-3 overflow-visible [@media(max-height:760px)]:grid-cols-[9rem_minmax(0,1fr)_16rem] [@media(max-height:760px)]:gap-2">
        <aside className="relative z-20 grid min-h-0 grid-rows-[auto_1fr_auto] gap-3 overflow-hidden [@media(max-height:760px)]:gap-2">
          <ControllerPlayerPanel
            currentPlayer={currentPlayer}
            isPriority={Boolean(playerId && turnState?.priority_player_id === playerId)}
          />
          <ControllerMinimaps players={opponentPlayers} registerAttackTargetRef={registerAttackTargetRef} />
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
        </aside>

        <main className="relative z-[80] grid min-h-0 grid-rows-[auto_1fr] overflow-visible">
          <ControllerBattlefieldList cards={battlefieldCards} selectedCardId={selectedCard?.id} onSelect={setSelectedCardId} />
          <div className="relative flex min-h-0 items-end justify-center overflow-visible rounded-[100%] border-t border-cyan-300/30 bg-cyan-500/5">
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
          />
          </div>
        </main>

        <aside className="relative z-30 grid min-h-0 grid-rows-[auto_1fr] gap-3 overflow-hidden [@media(max-height:760px)]:gap-2">
          <ControllerActionPad
            canPassPriority={canUseInstantActions}
            isPassingPriority={isPassingPriority}
            onPassPriority={handlePassPriority}
            selectedCard={selectedCard}
          />
          <SelectedCardDock
            card={selectedCard}
            playerId={playerId}
            sessionId={sessionId}
            isSessionFinished={isSessionFinished}
            sessionPlayers={sessionPlayers}
            stackItems={stackItems}
            canUseInstantActions={canUseInstantActions}
            canUseSorceryActions={canUseSorceryActions}
            landsPlayedThisTurn={turnState?.lands_played_this_turn ?? 0}
            landPlayLimit={turnState?.land_play_limit ?? 1}
          />
        </aside>
      </div>
      {showDevControls ? (
        <div className="relative z-20 mt-4">
          <DevAdminPanel
            sessionId={sessionId}
            currentPlayerId={playerId}
            sessionPlayers={sessionPlayers}
            turnState={turnState}
            onChanged={refreshControllerData}
          />
        </div>
      ) : null}
      {showDevControls && playerId ? (
        <PlayerActionPanel
          sessionId={sessionId}
          playerId={playerId}
          libraryCount={libraryCount}
          tappedBattlefieldCount={tappedBattlefieldCount}
          isSessionFinished={isSessionFinished}
        />
      ) : null}
      {showDevControls ? (
        <DraftZone
        card={draftedCard}
        isCasting={Boolean(draftedCard && swipeCastingCardId === draftedCard.id)}
        onClear={() => setDraftedCardId(null)}
        />
      ) : null}
      {showDevControls ? (
        <div className="relative z-20 mt-4">
          <ControllerCombatTargets
            canDeclareAttackers={canDeclareAttackers}
            attackUnavailableReason={attackUnavailableReason}
            defendingPlayers={defendingPlayers}
            canDeclareBlockers={canDeclareBlockers}
            blockUnavailableReason={blockUnavailableReason}
            blockableAssignments={blockableAssignments}
            registerAttackTargetRef={registerAttackTargetRef}
            registerBlockTargetRef={registerBlockTargetRef}
          />
        </div>
      ) : null}
      {handCards.length === 0 && battlefieldCards.length === 0 ? (
        <div className="rounded-lg bg-slate-900 p-4 text-sm text-slate-300">
          No cards in hand or on battlefield.
        </div>
      ) : null}
      {showDevControls ? (
        <>
          <CardSection
        title="Hand"
        cards={handCards}
        playerId={playerId}
        sessionId={sessionId}
        isSessionFinished={isSessionFinished}
          sessionPlayers={sessionPlayers}
          stackItems={stackItems}
          canUseInstantActions={canUseInstantActions}
        canUseSorceryActions={canUseSorceryActions}
        landsPlayedThisTurn={turnState?.lands_played_this_turn ?? 0}
        landPlayLimit={turnState?.land_play_limit ?? 1}
        turnNumber={turnState?.turn_number ?? 1}
        draftedCardId={draftedCardId}
        swipeCastingCardId={swipeCastingCardId}
        onSwipeCast={handleSwipeCast}
        onCombatDragEnd={handleCombatDragEnd}
          />
          <CardSection
        title="Battlefield"
        cards={battlefieldCards}
        playerId={playerId}
        sessionId={sessionId}
        canDeclareAttackers={canDeclareAttackers}
        attackUnavailableReason={attackUnavailableReason}
        defendingPlayers={defendingPlayers}
        declaringAttackerId={declaringAttackerId}
        onDeclareAttacker={handleDeclareAttacker}
        canDeclareBlockers={canDeclareBlockers}
        blockUnavailableReason={blockUnavailableReason}
        blockableAssignments={blockableAssignments}
        declaringBlockerId={declaringBlockerId}
        onDeclareBlocker={handleDeclareBlocker}
        isSessionFinished={isSessionFinished}
        sessionPlayers={sessionPlayers}
        canUseInstantActions={canUseInstantActions}
        canUseSorceryActions={canUseSorceryActions}
        landsPlayedThisTurn={turnState?.lands_played_this_turn ?? 0}
        landPlayLimit={turnState?.land_play_limit ?? 1}
        turnNumber={turnState?.turn_number ?? 1}
        draftedCardId={draftedCardId}
        swipeCastingCardId={swipeCastingCardId}
        onSwipeCast={handleSwipeCast}
        onCombatDragEnd={handleCombatDragEnd}
          />
        </>
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
    <section className="rounded-lg border border-cyan-200/25 bg-slate-950/75 p-3 shadow-[0_0_22px_rgba(34,211,238,0.12)] backdrop-blur [@media(max-height:760px)]:p-2">
      <div className="flex items-center gap-3">
        <div className="flex h-16 w-16 items-center justify-center rounded-lg border border-cyan-300/40 bg-cyan-950/30 text-lg font-bold text-cyan-100 [@media(max-height:760px)]:h-12 [@media(max-height:760px)]:w-12">
          P{currentPlayer?.seat_number ?? '-'}
        </div>
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">
            P{currentPlayer?.seat_number ?? '-'} {isPriority ? '- Priority' : ''}
          </p>
          <p className="truncate text-sm font-bold text-white">
            {currentPlayer?.username ?? 'No player'}
          </p>
          <p className="mt-1 text-xl font-bold text-white [@media(max-height:760px)]:text-lg">Life: {currentPlayer?.life_total ?? '-'}</p>
        </div>
      </div>
    </section>
  )
}

function ControllerBattlefieldList({
  cards,
  selectedCardId,
  onSelect,
}: {
  cards: ControllerCard[]
  selectedCardId?: string
  onSelect: (cardId: string) => void
}) {
  return (
    <section className="rounded-lg border border-white/15 bg-slate-950/70 p-3 shadow-xl shadow-black/30 backdrop-blur [@media(max-height:760px)]:p-2">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-sm font-bold text-cyan-200">Battlefield</h2>
        <span className="text-xs text-slate-500">{cards.length}</span>
      </div>
      <div className="grid max-h-32 gap-1 overflow-hidden [@media(max-height:760px)]:max-h-20">
        {cards.slice(0, 7).map((card) => (
          <button
            key={card.id}
            type="button"
            onClick={() => onSelect(card.id)}
            className={`flex min-w-0 items-center justify-between gap-2 rounded px-2 py-1 text-left text-sm ${
              selectedCardId === card.id ? 'bg-cyan-400/20 text-cyan-100' : 'text-slate-300'
            }`}
          >
            <span className="truncate">{card.name}</span>
            <span className="shrink-0 text-xs text-slate-500">{card.cards?.mana_cost}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

function ControllerActionPad({
  canPassPriority,
  isPassingPriority,
  onPassPriority,
  selectedCard,
}: {
  canPassPriority: boolean
  isPassingPriority: boolean
  onPassPriority: () => void
  selectedCard: ControllerCard | null
}) {
  return (
    <section className="rounded-lg border border-white/20 bg-slate-950/75 p-3 shadow-[0_0_26px_rgba(14,165,233,0.18)] backdrop-blur [@media(max-height:760px)]:p-2">
      <button
        type="button"
        onClick={onPassPriority}
        disabled={!canPassPriority || isPassingPriority}
        className="mb-3 h-16 w-full rounded-lg border border-cyan-200/60 bg-cyan-500 px-4 text-xl font-bold uppercase tracking-wide text-white shadow-[0_0_24px_rgba(14,165,233,0.75)] disabled:cursor-not-allowed disabled:bg-slate-600 disabled:opacity-60 [@media(max-height:760px)]:mb-2 [@media(max-height:760px)]:h-12 [@media(max-height:760px)]:text-base"
      >
        {isPassingPriority ? 'Passing...' : 'Pass Priority / OK'}
      </button>
      <div className="grid grid-cols-2 gap-2">
        {['Graveyard', '+/-', 'Commander', 'Mana Pool'].map((label) => (
          <button
            key={label}
            type="button"
            className="h-12 rounded-md border border-white/20 bg-white/15 text-sm font-bold uppercase text-white shadow-inner [@media(max-height:760px)]:h-9 [@media(max-height:760px)]:text-xs"
          >
            {label}
          </button>
        ))}
      </div>
      {selectedCard ? (
        <p className="mt-2 truncate text-xs text-slate-400">Selected: {selectedCard.name}</p>
      ) : null}
    </section>
  )
}

function ControllerMinimaps({
  players,
  registerAttackTargetRef,
}: {
  players: GameSessionPlayer[]
  registerAttackTargetRef: (playerId: string, element: HTMLElement | null) => void
}) {
  return (
    <aside className="grid min-h-0 content-center gap-2 overflow-hidden [@media(max-height:760px)]:gap-1">
      {players.map((player) => (
        <div
          key={player.player_id}
          ref={(element) => registerAttackTargetRef(player.player_id, element)}
          className="rounded-lg border border-cyan-200/20 bg-slate-950/70 p-3 shadow-xl shadow-black/30 backdrop-blur [@media(max-height:760px)]:p-2"
        >
          <p className="text-xs font-semibold text-cyan-300">P{player.seat_number}</p>
          <p className="text-3xl font-bold text-cyan-200 [@media(max-height:760px)]:text-2xl">{player.life_total}</p>
          <p className="truncate text-xs text-slate-300">{player.username}</p>
          <p className="text-xs text-slate-500">Life</p>
        </div>
      ))}
    </aside>
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
      className={`pointer-events-none absolute bottom-[13.75rem] left-1/2 z-10 w-[min(34rem,88%)] -translate-x-1/2 rounded-[1.25rem] border px-6 py-3 text-center backdrop-blur transition-shadow [@media(max-height:760px)]:bottom-[9.5rem] [@media(max-height:760px)]:w-[min(26rem,76%)] [@media(max-height:760px)]:px-3 [@media(max-height:760px)]:py-1.5 ${
        isHandRaised
          ? 'border-cyan-200/80 bg-cyan-500/20 shadow-[0_0_48px_rgba(34,211,238,0.58),inset_0_0_34px_rgba(34,211,238,0.14)]'
          : 'border-cyan-300/45 bg-cyan-950/35 shadow-[0_0_28px_rgba(34,211,238,0.22)]'
      }`}
    >
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-cyan-200 [@media(max-height:760px)]:text-[10px]">Play / Cast Zone</p>
      <p className="mt-1 truncate text-xs text-slate-300 [@media(max-height:760px)]:text-[10px]">
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
}) {
  return (
    <motion.div
      ref={handContainerRef}
      layout
      onPointerDown={() => onRaiseChange(true)}
      className="relative z-[90] flex h-[19rem] w-full items-end overflow-visible px-6 pb-0 [@media(max-height:760px)]:h-[12.5rem] [@media(max-height:760px)]:px-3"
    >
      <motion.div
        layout
        animate={{ y: isRaised ? -18 : 400 }}
        transition={{ type: 'spring', stiffness: 280, damping: 28 }}
        className="flex min-h-[19rem] min-w-full items-end justify-center gap-4 overflow-visible [@media(max-height:760px)]:min-h-[12.5rem] [@media(max-height:760px)]:gap-2"
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
              isSelected={isSelected}
              isCasting={swipeCastingCardId === card.id}
              isHandRaised={isRaised}
              onSelect={onSelect}
              onRaiseChange={onRaiseChange}
              onReorder={onReorder}
              onSwipeCast={onSwipeCast}
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
  isSelected,
  isCasting,
  isHandRaised,
  onSelect,
  onRaiseChange,
  onReorder,
  onSwipeCast,
}: {
  card: ControllerCard
  cardWidthClass: string
  index: number
  isSelected: boolean
  isCasting: boolean
  isHandRaised: boolean
  onSelect: (cardId: string) => void
  onRaiseChange: (isRaised: boolean) => void
  onReorder: (cardId: string, direction: -1 | 1) => void
  onSwipeCast: (card: ControllerCard, info: PanInfo) => void
}) {
  const dragControls = useDragControls()
  const [dragNonce, setDragNonce] = useState(0)

  return (
    <motion.div
      layout
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
        dragControls.start(event)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          onSelect(card.id)
        }
      }}
      onDragEnd={(_, info) => {
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
        y: isSelected && isHandRaised ? -12 : 0,
        rotate: isSelected ? -3 : 0,
        scale: isSelected ? 1.06 : 0.96,
        zIndex: isSelected ? 140 : 100 + index,
      }}
      exit={{ opacity: 0, y: 40 }}
      whileDrag={{ scale: 1.12, rotate: 0, zIndex: 999, cursor: 'grabbing' }}
      whileHover={{ y: -44, scale: 1.04 }}
      className={`relative shrink-0 origin-bottom cursor-grab touch-none select-none active:cursor-grabbing ${cardWidthClass}`}
    >
      <MotionCard
        card={{
          id: card.id,
          name: card.name,
          image_url: card.cards?.image_url,
          damage_marked: card.damage_marked,
          zone: card.zone,
        }}
        useLayoutId
        size="preview"
        className={isSelected ? 'border-cyan-300 shadow-[0_0_30px_rgba(34,211,238,0.65)]' : ''}
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
  landsPlayedThisTurn,
  landPlayLimit,
}: {
  card: ControllerCard | null
  playerId: string | null
  sessionId: string
  isSessionFinished: boolean
  sessionPlayers: GameSessionPlayer[]
  stackItems: StackItem[]
  canUseInstantActions: boolean
  canUseSorceryActions: boolean
  landsPlayedThisTurn: number
  landPlayLimit: number
}) {
  if (!card) {
    return null
  }

  return (
    <section className="min-h-0 overflow-hidden rounded-lg border border-white/20 bg-slate-950/90 p-3 shadow-[0_0_28px_rgba(14,165,233,0.18)] backdrop-blur [@media(max-height:760px)]:p-2">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-300 [@media(max-height:760px)]:mb-1">
        Selected Card
      </p>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-white">{card.name}</p>
          <p className="truncate text-xs text-slate-500">{card.cards?.type_line}</p>
        </div>
        <span className="shrink-0 rounded bg-cyan-400/15 px-2 py-1 text-xs font-semibold text-cyan-200">
          {card.zone}
        </span>
      </div>
      <div className="max-h-32 overflow-auto [@media(max-height:760px)]:max-h-20">
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
    </section>
  )
}

function getHandFanCardWidth(cardCount: number) {
  if (cardCount <= 4) {
    return 'w-24 sm:w-32 [@media(max-height:760px)]:w-20'
  }

  if (cardCount <= 7) {
    return 'w-24 sm:w-28 [@media(max-height:760px)]:w-[4.5rem]'
  }

  return 'w-20 sm:w-24 [@media(max-height:760px)]:w-16'
}

function orderCardsByIds(cards: ControllerCard[], orderedIds: string[]) {
  if (orderedIds.length === 0) {
    return cards
  }

  const cardsById = new Map(cards.map((card) => [card.id, card]))
  const orderedCards = orderedIds
    .map((cardId) => cardsById.get(cardId))
    .filter(Boolean) as ControllerCard[]
  const remainingCards = cards.filter((card) => !orderedIds.includes(card.id))

  return [...orderedCards, ...remainingCards]
}

function DraftZone({
  card,
  isCasting,
  onClear,
}: {
  card: ControllerCard | null
  isCasting: boolean
  onClear: () => void
}) {
  return (
    <AnimatePresence initial={false}>
      {card ? (
        <motion.section
          layout
          initial={{ opacity: 0, y: -16, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -16, scale: 0.98 }}
          transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          className="mb-5 rounded-lg border border-sky-400/60 bg-sky-950/40 p-4 shadow-xl shadow-sky-950/20"
        >
          <div className="flex items-center gap-4">
            <MotionCard
              card={{
                id: card.id,
                name: card.name,
                image_url: card.cards?.image_url,
                damage_marked: card.damage_marked,
                zone: 'draft',
              }}
              size="preview"
              useLayoutId={false}
              className="max-w-24"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-white">{card.name}</p>
              <p className="mt-1 text-xs text-slate-400">
                {isCasting
                  ? 'Casting from Draft Zone...'
                  : 'Draft Zone: finish choices with the visible controls, or cancel staging.'}
              </p>
            </div>
            <button
              type="button"
              onClick={onClear}
              disabled={isCasting}
              className="rounded-md border border-slate-600 px-3 py-2 text-sm font-semibold text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </motion.section>
      ) : null}
    </AnimatePresence>
  )
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
    <section className={`${compact ? 'h-full overflow-hidden p-3' : 'mb-5 p-4'} rounded-lg border border-cyan-300/30 bg-slate-950/80 shadow-[0_0_22px_rgba(34,211,238,0.12)]`}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-white">Combat</h2>
          <p className="text-xs text-slate-500">Drag creatures to targets.</p>
        </div>
        {canDeclareBlockers ? (
          <span className="rounded bg-red-500/15 px-2 py-1 text-xs font-semibold text-red-200">
            Defend: {blockableAssignments.length} incoming
          </span>
        ) : null}
      </div>

      {shouldShowAttackTargets ? (
        <div className="mb-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-cyan-200">
            Attack Targets
          </p>
          <div className={compact ? 'grid gap-2' : 'grid grid-cols-3 gap-2'}>
            {defendingPlayers.length > 0 ? (
              defendingPlayers.map((player) => (
                <div
                  key={player.player_id}
                  ref={(element) => registerAttackTargetRef(player.player_id, element)}
                  className={`rounded-md border ${compact ? 'p-2' : 'p-3'} ${
                    canDeclareAttackers
                      ? 'border-cyan-300/60 bg-cyan-950/30'
                      : 'border-slate-700 bg-slate-900/70 opacity-60'
                  }`}
                >
                  <p className="text-xs font-semibold text-slate-400">P{player.seat_number}</p>
                  <p className="truncate text-sm font-bold text-white">
                    {player.username || `Player ${player.player_id.slice(0, 8)}`}
                  </p>
                  <p className={compact ? 'text-xl font-bold text-cyan-200' : 'text-2xl font-bold text-cyan-200'}>{player.life_total}</p>
                </div>
              ))
            ) : (
              <p className="col-span-3 text-xs text-slate-500">No defending players.</p>
            )}
          </div>
          {!canDeclareAttackers && attackUnavailableReason ? (
            <p className="mt-2 text-xs text-slate-500">{attackUnavailableReason}</p>
          ) : null}
        </div>
      ) : null}

      {shouldShowBlockTargets ? (
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-red-200">
            Incoming Attackers
          </p>
          <div className="grid gap-2">
            {blockableAssignments.length > 0 ? (
              blockableAssignments.map((assignment) => (
                <div
                  key={assignment.id}
                  ref={(element) => registerBlockTargetRef(assignment.attacker_card_id, element)}
                  className={`rounded-md border p-3 ${
                    canDeclareBlockers
                      ? 'border-red-300/60 bg-red-950/30'
                      : 'border-slate-700 bg-slate-900/70 opacity-60'
                  }`}
                >
                  <p className="truncate text-sm font-bold text-white">{assignment.attacker_name}</p>
                  <p className="text-xs text-slate-400">
                    From {assignment.attacking_username} to {assignment.defending_username}
                  </p>
                </div>
              ))
            ) : (
              <p className="text-xs text-slate-500">No attackers are attacking you.</p>
            )}
          </div>
          {!canDeclareBlockers && blockUnavailableReason ? (
            <p className="mt-2 text-xs text-slate-500">{blockUnavailableReason}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function CardSection({
  title,
  cards,
  playerId,
  sessionId,
  canDeclareAttackers = false,
  attackUnavailableReason,
  defendingPlayers = [],
  declaringAttackerId,
  onDeclareAttacker,
  canDeclareBlockers = false,
  blockUnavailableReason,
  blockableAssignments = [],
  declaringBlockerId,
  onDeclareBlocker,
  isSessionFinished = false,
  sessionPlayers = [],
  stackItems = [],
  canUseInstantActions = false,
  canUseSorceryActions = false,
  landsPlayedThisTurn = 0,
  landPlayLimit = 1,
  turnNumber = 1,
  draftedCardId,
  swipeCastingCardId,
  onSwipeCast,
  onCombatDragEnd,
}: {
  title: string
  cards: ControllerCard[]
  playerId?: string | null
  sessionId?: string
  canDeclareAttackers?: boolean
  attackUnavailableReason?: string | null
  defendingPlayers?: GameSessionPlayer[]
  declaringAttackerId?: string | null
  onDeclareAttacker?: (attackerCardId: string, defendingPlayerId: string) => void
  canDeclareBlockers?: boolean
  blockUnavailableReason?: string | null
  blockableAssignments?: CombatAssignment[]
  declaringBlockerId?: string | null
  onDeclareBlocker?: (blockerCardId: string, attackerCardId: string) => void
  isSessionFinished?: boolean
  sessionPlayers?: GameSessionPlayer[]
  stackItems?: StackItem[]
  canUseInstantActions?: boolean
  canUseSorceryActions?: boolean
  landsPlayedThisTurn?: number
  landPlayLimit?: number
  turnNumber?: number
  draftedCardId?: string | null
  swipeCastingCardId?: string | null
  onSwipeCast?: (card: ControllerCard, info: PanInfo) => void
  onCombatDragEnd?: (card: ControllerCard, info: PanInfo) => void
}) {
  if (cards.length === 0) {
    return null
  }

  return (
    <section className="mb-5">
      <h2 className="mb-2 text-sm font-semibold text-slate-300">{title}</h2>
      <div className="grid grid-cols-1 gap-4">
        {cards.map((card) => (
          <motion.div
            key={card.id}
            layout
            drag={card.zone === 'hand' || card.zone === 'battlefield'}
            dragConstraints={
              card.zone === 'hand'
                ? { top: -160, bottom: 0 }
                : { top: -180, right: 180, bottom: 180, left: -180 }
            }
            dragElastic={0.18}
            onDragEnd={(_, info) => {
              onSwipeCast?.(card, info)
              onCombatDragEnd?.(card, info)
            }}
            whileHover={{ scale: card.zone === 'hand' ? 1.015 : 1.005 }}
            whileTap={{ scale: card.zone === 'hand' ? 0.985 : 1 }}
            transition={{ type: 'spring', stiffness: 360, damping: 32 }}
            className={`space-y-3 rounded-lg border p-4 shadow-lg shadow-black/20 ${
              draftedCardId === card.id
                ? 'border-sky-400/70 bg-sky-950/40'
                : 'border-white/10 bg-slate-800'
            } ${swipeCastingCardId === card.id ? 'opacity-60' : ''}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 gap-3">
                <CardThumbnail card={card} />
                <div className="min-w-0">
                  <span className="block truncate text-white font-medium">{card.name}</span>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    {card.cards?.mana_cost ? (
                      <span className="rounded bg-slate-950 px-2 py-0.5 text-xs text-slate-300">
                        {card.cards.mana_cost}
                      </span>
                    ) : null}
                    {getPowerToughnessLabel(card) ? (
                      <span className="rounded bg-white px-2 py-0.5 text-xs font-semibold text-slate-950">
                        {getPowerToughnessLabel(card)}
                      </span>
                    ) : null}
                  </div>
                  {card.cards?.type_line ? (
                    <span className="mt-1 block truncate text-xs text-slate-400">
                      {card.cards.type_line}
                    </span>
                  ) : null}
                  {card.damage_marked > 0 ? (
                    <span className="block text-xs text-red-300">Damage: {card.damage_marked}</span>
                  ) : null}
                  {card.zone === 'battlefield' ? <KeywordLabels card={card} /> : null}
                </div>
              </div>
              {showDevControls && card.zone === 'battlefield' ? (
                <CardController cardId={card.id} isTapped={card.is_tapped} disabled={isSessionFinished} />
              ) : null}
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
            {showDevControls && card.zone === 'battlefield' && sessionId ? (
              <StaticEffectControls
                cardId={card.id}
                sessionId={sessionId}
                controllerPlayerId={card.controller_player_id}
                copiedScript={card.copied_script}
                staticEffectsSuppressed={card.static_effects_suppressed}
                sessionPlayers={sessionPlayers}
                disabled={isSessionFinished}
              />
            ) : null}
            {card.zone === 'battlefield' && onDeclareAttacker ? (
              <DeclareAttackerControls
                card={card}
                canDeclareAttackers={canDeclareAttackers}
                attackUnavailableReason={attackUnavailableReason}
                defendingPlayers={defendingPlayers}
                isDeclaring={declaringAttackerId === card.id}
                turnNumber={turnNumber}
                onDeclareAttacker={onDeclareAttacker}
              />
            ) : null}
            {card.zone === 'battlefield' && onDeclareBlocker ? (
              <DeclareBlockerControls
                card={card}
                canDeclareBlockers={canDeclareBlockers}
                blockUnavailableReason={blockUnavailableReason}
                blockableAssignments={blockableAssignments}
                isDeclaring={declaringBlockerId === card.id}
                onDeclareBlocker={onDeclareBlocker}
              />
            ) : null}
            {playerId && sessionId && (card.zone === 'battlefield' || card.zone === 'hand') ? (
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
          </motion.div>
        ))}
      </div>
    </section>
  )
}

function CardThumbnail({ card }: { card: ControllerCard }) {
  const [isPressed, setIsPressed] = useState(false)
  const imageUrl = card.cards?.image_url

  return (
    <div
      tabIndex={0}
      role="button"
      aria-label={`Preview ${card.name}`}
      onPointerDown={() => setIsPressed(true)}
      onPointerUp={() => setIsPressed(false)}
      onPointerCancel={() => setIsPressed(false)}
      onPointerLeave={() => setIsPressed(false)}
      onContextMenu={(event) => event.preventDefault()}
      className="group relative h-20 w-14 shrink-0 touch-none select-none overflow-hidden rounded border border-slate-700 bg-slate-900 focus:outline-none focus:ring-2 focus:ring-sky-300"
    >
      <MotionCard
        card={{
          id: card.id,
          name: card.name,
          image_url: imageUrl,
          damage_marked: card.damage_marked,
          zone: card.zone,
        }}
        size="thumb"
        interactive
        className="border-0 shadow-none"
        showNameFallback={false}
      />
      {imageUrl ? (
        <div
          className={`pointer-events-none fixed left-1/2 top-1/2 z-50 w-64 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-slate-600 bg-slate-950 p-2 shadow-2xl shadow-black/70 group-hover:block group-focus:block sm:w-72 ${
            isPressed ? 'block' : 'hidden'
          }`}
        >
          <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-slate-900">
            <Image
              src={imageUrl}
              alt={card.name || 'Magic card preview'}
              fill
              sizes="288px"
              className="object-cover"
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}

function KeywordLabels({ card }: { card: ControllerCard }) {
  const labels = getSupportedKeywordLabels(card)

  if (labels.length === 0) {
    return null
  }

  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {labels.map((label) => (
        <span key={label} className="rounded bg-emerald-950 px-2 py-0.5 text-xs text-emerald-200">
          {label}
        </span>
      ))}
    </div>
  )
}

function DeclareBlockerControls({
  card,
  canDeclareBlockers,
  blockUnavailableReason,
  blockableAssignments,
  isDeclaring,
  onDeclareBlocker,
}: {
  card: ControllerCard
  canDeclareBlockers: boolean
  blockUnavailableReason?: string | null
  blockableAssignments: CombatAssignment[]
  isDeclaring: boolean
  onDeclareBlocker: (blockerCardId: string, attackerCardId: string) => void
}) {
  const [attackerCardId, setAttackerCardId] = useState(blockableAssignments[0]?.attacker_card_id ?? '')
  const resolvedAttackerCardId = attackerCardId || blockableAssignments[0]?.attacker_card_id || ''
  const isDisabled =
    !canDeclareBlockers || card.is_tapped || isDeclaring || blockableAssignments.length === 0
  const disabledReason = getDeclareBlockerDisabledReason({
    card,
    canDeclareBlockers,
    blockUnavailableReason,
    blockableAssignments,
    isDeclaring,
  })

  if (blockableAssignments.length === 0 && !blockUnavailableReason) {
    return null
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-slate-700 p-3 sm:flex-row sm:items-center">
      <select
        value={resolvedAttackerCardId}
        onChange={(event) => setAttackerCardId(event.target.value)}
        disabled={isDeclaring || blockableAssignments.length === 0}
        className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {blockableAssignments.length === 0 ? (
          <option value="">No attackers</option>
        ) : (
          blockableAssignments.map((assignment) => (
            <option key={assignment.id} value={assignment.attacker_card_id}>
              {assignment.attacker_name} attacking {assignment.defending_username}
            </option>
          ))
        )}
      </select>
      <button
        type="button"
        onClick={() => onDeclareBlocker(card.id, resolvedAttackerCardId)}
        disabled={isDisabled}
        className="rounded-md bg-sky-400 px-3 py-2 text-sm font-semibold text-sky-950 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isDeclaring ? 'Blocking...' : 'Block'}
      </button>
      {disabledReason ? <p className="text-xs text-slate-500 sm:basis-full">{disabledReason}</p> : null}
    </div>
  )
}

function DeclareAttackerControls({
  card,
  canDeclareAttackers,
  attackUnavailableReason,
  defendingPlayers,
  isDeclaring,
  turnNumber,
  onDeclareAttacker,
}: {
  card: ControllerCard
  canDeclareAttackers: boolean
  attackUnavailableReason?: string | null
  defendingPlayers: GameSessionPlayer[]
  isDeclaring: boolean
  turnNumber: number
  onDeclareAttacker: (attackerCardId: string, defendingPlayerId: string) => void
}) {
  const [defendingPlayerId, setDefendingPlayerId] = useState(defendingPlayers[0]?.player_id ?? '')
  const resolvedDefendingPlayerId = defendingPlayerId || defendingPlayers[0]?.player_id || ''
  const disabledReason = getDeclareAttackerDisabledReason({
    card,
    canDeclareAttackers,
    attackUnavailableReason,
    defendingPlayers,
    isDeclaring,
    turnNumber,
  })
  const isDisabled = Boolean(disabledReason)

  if (defendingPlayers.length === 0) {
    return null
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-slate-700 p-3 sm:flex-row sm:items-center">
      <select
        value={resolvedDefendingPlayerId}
        onChange={(event) => setDefendingPlayerId(event.target.value)}
        disabled={isDeclaring}
        className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {defendingPlayers.map((player) => (
          <option key={player.player_id} value={player.player_id}>
            {player.username || `Player ${player.player_id.slice(0, 8)}`}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => onDeclareAttacker(card.id, resolvedDefendingPlayerId)}
        disabled={isDisabled}
        className="rounded-md bg-amber-400 px-3 py-2 text-sm font-semibold text-amber-950 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isDeclaring ? 'Attacking...' : 'Attack'}
      </button>
      {disabledReason ? <p className="text-xs text-slate-500 sm:basis-full">{disabledReason}</p> : null}
      {!disabledReason && cardHasPrintedOrCopiedVigilance(card) ? (
        <p className="text-xs text-emerald-300 sm:basis-full">Vigilance: this creature will not tap.</p>
      ) : null}
      {!disabledReason && cardHasPrintedOrCopiedKeyword(card, 'trample') ? (
        <p className="text-xs text-emerald-300 sm:basis-full">
          Trample: excess combat damage can hit the defending player.
        </p>
      ) : null}
      {!disabledReason && cardHasPrintedOrCopiedKeyword(card, 'first_strike') ? (
        <p className="text-xs text-emerald-300 sm:basis-full">
          First strike: this creature deals combat damage before regular damage.
        </p>
      ) : null}
      {!disabledReason && cardHasPrintedOrCopiedKeyword(card, 'double_strike') ? (
        <p className="text-xs text-emerald-300 sm:basis-full">
          Double strike: this creature deals first strike and regular combat damage.
        </p>
      ) : null}
    </div>
  )
}

function getDeclareAttackerDisabledReason({
  card,
  canDeclareAttackers,
  attackUnavailableReason,
  defendingPlayers,
  isDeclaring,
  turnNumber,
}: {
  card: ControllerCard
  canDeclareAttackers: boolean
  attackUnavailableReason?: string | null
  defendingPlayers: GameSessionPlayer[]
  isDeclaring: boolean
  turnNumber: number
}) {
  if (isDeclaring) {
    return 'Declaring attacker...'
  }

  if (defendingPlayers.length === 0) {
    return 'No defending players available.'
  }

  if (card.is_tapped) {
    return 'Tapped cards cannot be declared as attackers yet.'
  }

  if (!isCreatureCard(card)) {
    return 'Only creatures can attack.'
  }

  if (hasSummoningSickness(card, turnNumber)) {
    return 'Creature has summoning sickness.'
  }

  if (!canDeclareAttackers) {
    return attackUnavailableReason ?? 'Attack is not available right now.'
  }

  return null
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

function getElementHitId(info: PanInfo, elements: Map<string, HTMLElement>) {
  for (const [id, element] of elements.entries()) {
    const rect = element.getBoundingClientRect()

    if (
      info.point.x >= rect.left &&
      info.point.x <= rect.right &&
      info.point.y >= rect.top &&
      info.point.y <= rect.bottom
    ) {
      return id
    }
  }

  return null
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

function onBoardPoint(info: PanInfo, elements: Map<string, HTMLElement>) {
  return Boolean(getElementHitId(info, elements))
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

function hasSummoningSickness(card: ControllerCard, turnNumber: number) {
  const enteredTurn = card.entered_battlefield_turn_number

  if (enteredTurn === null || enteredTurn === undefined) {
    return false
  }

  if (enteredTurn < turnNumber) {
    return false
  }

  return !cardHasPrintedOrCopiedHaste(card)
}

function cardHasPrintedOrCopiedHaste(card: ControllerCard) {
  return cardHasPrintedOrCopiedKeyword(card, 'haste')
}

function cardHasPrintedOrCopiedVigilance(card: ControllerCard) {
  return cardHasPrintedOrCopiedKeyword(card, 'vigilance')
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

function getDeclareBlockerDisabledReason({
  card,
  canDeclareBlockers,
  blockUnavailableReason,
  blockableAssignments,
  isDeclaring,
}: {
  card: ControllerCard
  canDeclareBlockers: boolean
  blockUnavailableReason?: string | null
  blockableAssignments: CombatAssignment[]
  isDeclaring: boolean
}) {
  if (isDeclaring) {
    return 'Declaring blocker...'
  }

  if (blockableAssignments.length === 0) {
    return blockUnavailableReason ?? 'No attackers are attacking you.'
  }

  if (card.is_tapped) {
    return 'Tapped cards cannot be declared as blockers yet.'
  }

  if (!canDeclareBlockers) {
    return blockUnavailableReason ?? 'Block is not available right now.'
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
