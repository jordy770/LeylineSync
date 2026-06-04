import type {
  BoardCard,
  CombatAssignment,
  GameSessionPlayer,
  StackItem,
} from './types'

export type BoardSeat = {
  player: GameSessionPlayer | null
  cards: BoardCard[]
  index: number
  isPriority: boolean
}

export type BoardConnection = {
  id: string
  lane: 'combat' | 'stack'
  label: string
  path: string
}

export function buildBoardSeats(
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

export function getCombatCardIds(assignments: CombatAssignment[]) {
  const cardIds = new Set<string>()

  for (const assignment of assignments) {
    cardIds.add(assignment.attacker_card_id)
    for (const blocker of assignment.blockers ?? []) {
      cardIds.add(blocker.blocker_card_id)
    }
  }

  return cardIds
}

export function getFocusSeat(seats: BoardSeat[], focusedPlayerId?: string | null) {
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

export function buildBoardConnections(
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
