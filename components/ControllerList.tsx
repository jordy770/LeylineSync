// components/ControllerList.tsx
'use client'
import Image from 'next/image'
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { declareAttacker, declareBlocker, getErrorMessage } from '@/lib/game/actions'
import { enableFallbackRefresh, showDevControls } from '@/lib/game/dev'
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
  const battlefieldCards = cards.filter((card) => card.zone === 'battlefield')
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
    <>
      {lastFetchInfo ? <p className="mb-3 text-xs text-slate-500">{lastFetchInfo}</p> : null}
      {showDevControls ? (
        <DevAdminPanel
          sessionId={sessionId}
          currentPlayerId={playerId}
          sessionPlayers={sessionPlayers}
          turnState={turnState}
          onChanged={refreshControllerData}
        />
      ) : null}
      {playerId ? (
        <PlayerActionPanel
          sessionId={sessionId}
          playerId={playerId}
          libraryCount={libraryCount}
          tappedBattlefieldCount={tappedBattlefieldCount}
          isSessionFinished={isSessionFinished}
        />
      ) : null}
      {handCards.length === 0 && battlefieldCards.length === 0 ? (
        <div className="rounded-lg bg-slate-900 p-4 text-sm text-slate-300">
          No cards in hand or on battlefield.
        </div>
      ) : null}
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
      />
    </>
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
}) {
  if (cards.length === 0) {
    return null
  }

  return (
    <section className="mb-5">
      <h2 className="mb-2 text-sm font-semibold text-slate-300">{title}</h2>
      <div className="grid grid-cols-1 gap-4">
        {cards.map((card) => (
          <div key={card.id} className="space-y-3 rounded-lg bg-slate-800 p-4">
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
          </div>
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
      {imageUrl ? (
        <Image
          src={imageUrl}
          alt={card.name || 'Magic card'}
          fill
          sizes="56px"
          className="object-cover"
        />
      ) : (
        <div className="flex h-full items-center justify-center px-1 text-center text-[10px] text-slate-500">
          No image
        </div>
      )}
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
