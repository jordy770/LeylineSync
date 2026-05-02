export type ManaPool = Record<string, number>

export type ManaColor = 'W' | 'U' | 'B' | 'R' | 'G' | 'C'

export type GameZone = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile'

export type GameSessionStatus = 'open' | 'locked' | 'finished'

export type GameSession = {
  id: string
  status: GameSessionStatus
  created_by: string
  created_at?: string
  locked_at?: string | null
  finished_at?: string | null
  winner_player_id?: string | null
}

export type GameSessionPlayer = {
  session_id: string
  player_id: string
  username?: string | null
  seat_number: number
  life_total: number
  joined_at?: string
}

export type TurnPhase = 'beginning' | 'main_1' | 'combat' | 'main_2' | 'ending'

export type TurnStep =
  | 'untap'
  | 'upkeep'
  | 'draw'
  | 'precombat_main'
  | 'beginning_of_combat'
  | 'declare_attackers'
  | 'declare_blockers'
  | 'combat_damage'
  | 'end_of_combat'
  | 'postcombat_main'
  | 'end'
  | 'cleanup'

export type GameTurnState = {
  session_id: string
  active_player_id: string
  priority_player_id?: string | null
  turn_number: number
  phase: TurnPhase
  step: TurnStep
  created_at?: string
  updated_at?: string
}

export type CombatAssignment = {
  id: string
  session_id: string
  turn_number: number
  attacker_card_id: string
  attacker_name: string
  attacking_player_id: string
  attacking_username: string
  defending_player_id: string
  defending_username: string
  blocker_card_id?: string | null
  blocker_name?: string | null
  created_at?: string
}

export type CombatActionState = {
  can_declare_attackers: boolean
  can_declare_blockers?: boolean
  can_resolve_combat_damage?: boolean
  reason?: string | null
  attack_reason?: string | null
  block_reason?: string | null
  damage_reason?: string | null
  blockable_attackers_count?: number
  unresolved_combat_count?: number
  active_player_id?: string | null
  priority_player_id?: string | null
  current_player_id?: string | null
  turn_number?: number
  phase?: TurnPhase | string
  step?: TurnStep | string
}

export type CombatDamageResult = {
  assignments_resolved: number
  total_damage: number
  finished?: boolean
  winner_player_id?: string | null
}

export type CardAction = {
  type: string
  color?: string
  amount?: number
}

export type CardScript = {
  actions?: CardAction[]
  triggers?: string[]
}

export type LinkedCard = {
  id: string
  name: string | null
  image_url?: string | null
  script?: CardScript | null
  type_line?: string | null
}

export type BoardCard = {
  id: string
  card_id: string
  name: string
  is_tapped: boolean
  position_x: number
  position_y: number
  zone: GameZone
  image_url: string | null
}

export type ControllerCard = {
  id: string
  card_id: string
  name: string
  is_tapped: boolean
  zone: GameZone
  zone_position: number
  cards: LinkedCard | null
}

export type GameCardInstanceRow = {
  id: string
  card_id: string
  position_x?: number
  position_y?: number
  is_tapped: boolean
  zone?: GameZone | string
  zone_position?: number
}

export type SupabaseErrorLike = {
  code?: string
  details?: string
  hint?: string
  message?: string
}
