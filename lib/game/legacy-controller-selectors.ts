import type {
  BoardCard,
  CombatActionState,
  CombatAssignment,
  ControllerCard,
  GameSessionPlayer,
  StackItem,
} from './types'

export type LegacyControllerViewFocus = 'me' | `opponent_${string}`

export function orderCardsByIds(cards: ControllerCard[], orderedIds: string[]) {
  const cardsById = new Map(cards.map((card) => [card.id, card]))
  const orderedCards = orderedIds
    .map((cardId) => cardsById.get(cardId))
    .filter((card): card is ControllerCard => Boolean(card))
  const remainingCards = cards.filter((card) => !orderedIds.includes(card.id))

  return [...orderedCards, ...remainingCards]
}

export function selectLegacyControllerViewModel({
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
}: {
  cards: ControllerCard[]
  allBoardCards: BoardCard[]
  handOrder: string[]
  draftedCardId: string | null
  selectedCardId: string | null
  sessionPlayers: GameSessionPlayer[]
  playerId: string | null
  viewFocus: LegacyControllerViewFocus
  combatActionState: CombatActionState | null
  combatAssignments: CombatAssignment[]
  isSessionFinished: boolean
  stackItems: StackItem[]
  pendingStackCount: number
}) {
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
  const focusTabs: Array<{ id: LegacyControllerViewFocus; player: GameSessionPlayer | null }> = [
    { id: 'me', player: currentPlayer },
    ...opponentPlayers.map((player) => ({
      id: `opponent_${player.player_id}` as LegacyControllerViewFocus,
      player,
    })),
  ]
  const focusedOpponentPlayer =
    viewFocus === 'me'
      ? null
      : focusTabs.find((tab) => tab.id === viewFocus)?.player ?? null
  const focusedOpponentBoardCards = focusedOpponentPlayer
    ? allBoardCards.filter((card) => card.controller_player_id === focusedOpponentPlayer.player_id)
    : []
  const libraryCount = cards.filter((card) => card.zone === 'library').length
  const defendingPlayers = sessionPlayers.filter((player) => player.player_id !== playerId)
  const blockableAssignments = combatAssignments.filter(
    (assignment) => assignment.defending_player_id === playerId,
  )
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
  const pendingStackItems = stackItems.filter((item) => item.status === 'pending')

  return {
    handCards,
    orderedHandCards,
    battlefieldCards,
    draftedCard,
    selectedCard,
    currentPlayer,
    opponentPlayers,
    focusTabs,
    focusedOpponentPlayer,
    focusedOpponentBoardCards,
    libraryCount,
    defendingPlayers,
    blockableAssignments,
    canUseInstantActions,
    canUseSorceryActions,
    pendingStackItems,
  }
}
