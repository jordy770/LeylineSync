import type {
  CombatActionState,
  ControllerCard,
  GameSessionPlayer,
  StackItem,
} from './types'

export function selectControllerViewModel({
  cards,
  players,
  playerId,
  combatActionState,
  isSessionFinished,
  stackItems,
  selectedCardId,
  selectedStackTargetId,
}: {
  cards: ControllerCard[]
  players: GameSessionPlayer[]
  playerId: string | null
  combatActionState: CombatActionState | null
  isSessionFinished: boolean
  stackItems: StackItem[]
  selectedCardId: string | null
  selectedStackTargetId: string | null
}) {
  const handCards = cards
    .filter((card) => card.zone === 'hand')
    .sort((left, right) => left.zone_position - right.zone_position)
  const battlefieldCards = cards.filter((card) => card.zone === 'battlefield')
  const graveyardCount = cards.filter((card) => card.zone === 'graveyard').length
  const libraryCount = cards.filter((card) => card.zone === 'library').length
  const pendingStackItems = stackItems.filter((item) => item.status === 'pending')
  const currentPlayer = players.find((player) => player.player_id === playerId) ?? null
  const opponentPlayers = players.filter((player) => player.player_id !== playerId)
  const selectedCard = (selectedCardId ? cards.find((card) => card.id === selectedCardId) : null) ?? null
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
      (combatActionState?.step === 'precombat_main' || combatActionState?.step === 'postcombat_main') &&
      pendingStackItems.length === 0,
  )
  const responseCards = cards.filter((card) => canCardRespond(card, pendingStackItems.length > 0))
  const stackTargetCard =
    selectedCard && doesCardRequireStackTarget(selectedCard)
      ? pendingStackItems.find((item) => item.id === selectedStackTargetId) ?? pendingStackItems[0] ?? null
      : null

  return {
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
  }
}

export function getCanQuickCast(
  card: ControllerCard,
  canUseSorceryActions: boolean,
  canUseInstantActions: boolean,
  pendingStackCount: number,
) {
  if (card.zone !== 'hand') {
    return false
  }

  if (doesCardRequireStackTarget(card)) {
    return canUseInstantActions && pendingStackCount > 0
  }

  // Front face only: an Adventure creature's type_line is
  // "Creature — X // Instant — Adventure" — the back half must not make the
  // CREATURE cast at instant speed (client twin of the mig 373 server fix).
  const typeLine = (card.cards?.type_line ?? '').split(' // ')[0].toLowerCase()

  if (typeLine.includes('instant')) {
    return canUseInstantActions
  }

  return canUseSorceryActions
}

export function canCardRespond(card: ControllerCard, hasPendingStackItems: boolean) {
  if (card.zone === 'battlefield') {
    return card.cards?.script?.actions?.some((action) => action.timing === 'instant' || action.type.includes('mana')) ?? false
  }

  if (card.zone !== 'hand') {
    return false
  }

  // Front face only — see getCanQuickCast: the Adventure back half is not a
  // response the creature card can make.
  const typeLine = (card.cards?.type_line ?? '').split(' // ')[0].toLowerCase()
  return typeLine.includes('instant') || (hasPendingStackItems && doesCardRequireStackTarget(card))
}

export function doesCardRequireStackTarget(card: ControllerCard) {
  // Front face only (bug-1512, third member of the dual-type-line family):
  // "Creature — X // Instant — Adventure" + 'target' in the oracle text made
  // the whole card read as a counterspell — uncastable on an empty stack.
  const typeLine = (card.cards?.type_line ?? '').split(' // ')[0].toLowerCase()
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

export function isLandCard(card: ControllerCard) {
  return card.cards?.type_line?.toLowerCase().includes('land') ?? false
}

export function getPowerToughnessLabel(card: ControllerCard) {
  const linkedCard = card.cards

  if (!linkedCard || !linkedCard.type_line?.toLowerCase().includes('creature')) {
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

function normalizeKeyword(keyword: string | undefined) {
  return (keyword ?? '').toLowerCase().replace(/[\s-]+/g, '_')
}
