export type ManaPool = Record<string, number>

export type ManaColor = 'W' | 'U' | 'B' | 'R' | 'G' | 'C'

export type GameZone = 'library' | 'hand' | 'stack' | 'battlefield' | 'graveyard' | 'exile'

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

export type DeckImportResult = {
  id: string | null
  name: string
  card_count: number
  missing?: Array<{
    line_number: number
    line: string
    name: string
    quantity: number
  }>
}

export type DeckSummary = {
  id: string
  name: string | null
  card_count: number
  created_at?: string | null
}

export type DeckCardLine = {
  card_id: string
  quantity: number
  card: LinkedCard | null
}

export type DeckDetail = DeckSummary & {
  cards: DeckCardLine[]
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
  active_username?: string | null
  priority_player_id?: string | null
  priority_username?: string | null
  priority_cycle_started_by?: string | null
  priority_pass_count?: number
  lands_played_this_turn?: number
  land_play_limit?: number
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
  blocker_count?: number
  blockers?: CombatBlocker[]
  created_at?: string
}

export type CombatBlocker = {
  id: string
  blocker_card_id: string
  blocker_name: string
  damage_assignment_order: number
  blocking_player_id?: string | null
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
  damage_stage?: 'first_strike' | 'regular' | string
  total_damage: number
  total_player_damage?: number
  total_creature_damage?: number
  creatures_destroyed?: number
  finished?: boolean
  winner_player_id?: string | null
}

export type StackItem = {
  id: string
  session_id: string
  controller_player_id: string
  controller_username?: string | null
  source_card_id?: string | null
  source_card_name?: string | null
  target_player_id?: string | null
  target_username?: string | null
  action_type: string
  payload: Record<string, unknown>
  position: number
  status: 'pending' | 'resolved' | 'cancelled' | string
  created_at?: string
  resolved_at?: string | null
}

export type GameActionLog = {
  id: string
  session_id: string
  actor_player_id: string
  target_player_id?: string | null
  action_type: string
  description?: string | null
  before_state: Record<string, unknown>
  after_state: Record<string, unknown>
  created_at: string
  undone_at?: string | null
  undone_by?: string | null
}

export type CardAction = {
  type: string
  color?: string
  colors?: string[]
  amount?: number
  target?: 'player' | 'spell' | string
  target_type?: 'player' | 'spell' | string
  timing?: 'instant' | 'sorcery' | string
  expires_at_phase?: string
  expires_at_step?: string
}

export type CardContinuousEffect = {
  type?: string
  effect_type?: string
  affected?: 'controller' | 'self' | 'all' | 'all_players' | string
  source_zone_required?: GameZone | string
  amount?: number
  colors?: string[]
  payload?: Record<string, unknown>
  expires_at_turn_number?: number
  expires_at_phase?: string
  expires_at_step?: string
}

export type CardScript = {
  actions?: CardAction[]
  continuous_effects?: CardContinuousEffect[]
  triggers?: string[]
}

export type LinkedCard = {
  id: string
  name: string | null
  image_url?: string | null
  script?: CardScript | null
  type_line?: string | null
  mana_cost?: string | null
  keywords?: string[] | null
  power?: number | null
  toughness?: number | null
  power_toughness?: string | null
}

export type CardCatalogFilters = {
  search?: string
  type?: 'all' | 'artifact' | 'creature' | 'enchantment' | 'instant' | 'land' | 'planeswalker' | 'sorcery'
  color?: 'all' | ManaColor
  keyword?: string
  limit?: number
}

export type BoardCard = {
  id: string
  card_id: string
  name: string
  is_tapped: boolean
  damage_marked: number
  position_x: number
  position_y: number
  zone: GameZone
  image_url: string | null
  type_line?: string | null
  controller_player_id?: string | null
}

export type ControllerCard = {
  id: string
  card_id: string
  name: string
  is_tapped: boolean
  damage_marked: number
  zone: GameZone
  zone_position: number
  controller_player_id?: string | null
  copied_script?: CardScript | null
  static_effects_suppressed?: boolean
  entered_battlefield_turn_number?: number | null
  cards: LinkedCard | null
}

export type GameCardInstanceRow = {
  id: string
  card_id: string
  position_x?: number
  position_y?: number
  is_tapped: boolean
  damage_marked?: number
  zone?: GameZone | string
  zone_position?: number
  controller_player_id?: string | null
  copied_script?: CardScript | null
  static_effects_suppressed?: boolean
  entered_battlefield_turn_number?: number | null
}

export type SupabaseErrorLike = {
  code?: string
  details?: string
  hint?: string
  message?: string
}
