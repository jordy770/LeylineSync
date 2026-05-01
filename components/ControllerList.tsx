// components/ControllerList.tsx
'use client'
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { declareAttacker, declareBlocker, getErrorMessage } from '@/lib/game/actions'
import {
  getCombatActionState,
  getCombatAssignments,
  getControllerCards,
  getCurrentPlayerId,
  getGameSessionPlayers,
} from '@/lib/game/data'
import type {
  CombatActionState,
  CombatAssignment,
  ControllerCard,
  GameSessionPlayer,
} from '@/lib/game/types'
import CardController from './CardController'
import ActionButtons from './ActionButtons'
import CardZoneControls from './CardZoneControls'
import PlayerActionPanel from './PlayerActionPanel'

export default function ControllerList({ sessionId }: { sessionId: string }) {
  const [cards, setCards] = useState<ControllerCard[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [lastFetchInfo, setLastFetchInfo] = useState<string | null>(null)
  const [playerId, setPlayerId] = useState<string | null>(null)
  const [combatActionState, setCombatActionState] = useState<CombatActionState | null>(null)
  const [combatAssignments, setCombatAssignments] = useState<CombatAssignment[]>([])
  const [sessionPlayers, setSessionPlayers] = useState<GameSessionPlayer[]>([])
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
        const [nextCombatActionState, nextCombatAssignments, nextSessionPlayers] = await Promise.all([
          getCombatActionState(supabase, sessionId),
          getCombatAssignments(supabase, sessionId),
          getGameSessionPlayers(supabase, sessionId),
        ])

        if (isMounted) {
          setCombatActionState(nextCombatActionState)
          setCombatAssignments(nextCombatAssignments)
          setSessionPlayers(nextSessionPlayers)
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

    const refreshInterval = window.setInterval(() => {
      if (currentPlayerId) {
        fetchCards(currentPlayerId)
      }
      loadGameContext()
    }, 2000)

    return () => {
      isMounted = false
      window.clearInterval(refreshInterval)
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

  if (cards.length === 0) {
    return (
      <div className="rounded-lg bg-slate-900 p-4 text-sm text-slate-300 space-y-2">
        <p>No cards found for session <span className="font-mono">{sessionId}</span>.</p>
        {lastFetchInfo ? <p className="text-slate-500">{lastFetchInfo}</p> : null}
      </div>
    )
  }

  const handCards = cards.filter((card) => card.zone === 'hand')
  const battlefieldCards = cards.filter((card) => card.zone === 'battlefield')
  const libraryCount = cards.filter((card) => card.zone === 'library').length
  const tappedBattlefieldCount = battlefieldCards.filter((card) => card.is_tapped).length
  const defendingPlayers = sessionPlayers.filter((player) => player.player_id !== playerId)
  const attackUnavailableReason = getAttackUnavailableReason({ combatActionState, defendingPlayers })
  const canDeclareAttackers = !attackUnavailableReason
  const blockableAssignments = combatAssignments.filter(
    (assignment) => assignment.defending_player_id === playerId && !assignment.blocker_card_id,
  )
  const blockUnavailableReason = getBlockUnavailableReason({
    combatActionState,
    blockableAssignments,
  })
  const canDeclareBlockers = !blockUnavailableReason

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
      {playerId ? (
        <PlayerActionPanel
          sessionId={sessionId}
          playerId={playerId}
          libraryCount={libraryCount}
          tappedBattlefieldCount={tappedBattlefieldCount}
        />
      ) : null}
      {handCards.length === 0 && battlefieldCards.length === 0 ? (
        <div className="rounded-lg bg-slate-900 p-4 text-sm text-slate-300">
          No cards in hand or on battlefield.
        </div>
      ) : null}
      <CardSection title="Hand" cards={handCards} />
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
            <div className="flex items-center justify-between gap-3">
              <span className="text-white font-medium">{card.name}</span>
              {card.zone === 'battlefield' ? (
                <CardController cardId={card.id} isTapped={card.is_tapped} />
              ) : null}
            </div>
            <CardZoneControls cardId={card.id} zone={card.zone} />
            {card.zone === 'battlefield' && onDeclareAttacker ? (
              <DeclareAttackerControls
                card={card}
                canDeclareAttackers={canDeclareAttackers}
                attackUnavailableReason={attackUnavailableReason}
                defendingPlayers={defendingPlayers}
                isDeclaring={declaringAttackerId === card.id}
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
            {playerId && sessionId && card.zone === 'battlefield' ? (
              <ActionButtons card={card} sessionId={sessionId} playerId={playerId} />
            ) : null}
          </div>
        ))}
      </div>
    </section>
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
  onDeclareAttacker,
}: {
  card: ControllerCard
  canDeclareAttackers: boolean
  attackUnavailableReason?: string | null
  defendingPlayers: GameSessionPlayer[]
  isDeclaring: boolean
  onDeclareAttacker: (attackerCardId: string, defendingPlayerId: string) => void
}) {
  const [defendingPlayerId, setDefendingPlayerId] = useState(defendingPlayers[0]?.player_id ?? '')
  const resolvedDefendingPlayerId = defendingPlayerId || defendingPlayers[0]?.player_id || ''
  const isDisabled =
    !canDeclareAttackers || card.is_tapped || isDeclaring || defendingPlayers.length === 0
  const disabledReason = getDeclareAttackerDisabledReason({
    card,
    canDeclareAttackers,
    attackUnavailableReason,
    defendingPlayers,
    isDeclaring,
  })

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
    </div>
  )
}

function getDeclareAttackerDisabledReason({
  card,
  canDeclareAttackers,
  attackUnavailableReason,
  defendingPlayers,
  isDeclaring,
}: {
  card: ControllerCard
  canDeclareAttackers: boolean
  attackUnavailableReason?: string | null
  defendingPlayers: GameSessionPlayer[]
  isDeclaring: boolean
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

  if (!canDeclareAttackers) {
    return attackUnavailableReason ?? 'Attack is not available right now.'
  }

  return null
}

function getAttackUnavailableReason({
  combatActionState,
  defendingPlayers,
}: {
  combatActionState: CombatActionState | null
  defendingPlayers: GameSessionPlayer[]
}) {
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
}: {
  combatActionState: CombatActionState | null
  blockableAssignments: CombatAssignment[]
}) {
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
