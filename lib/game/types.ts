export type ManaPool = Record<string, number>

export type ManaColor = 'W' | 'U' | 'B' | 'R' | 'G' | 'C'

export type GameZone = 'library' | 'hand' | 'stack' | 'battlefield' | 'graveyard' | 'exile' | 'command'

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
  // Player counter bag (poison/energy/experience). Empty when the player has none.
  counters?: Record<string, number> | null
  // Opening-hand state (mig 221/222): times mulliganed + whether the hand was
  // kept. opening_hand_kept is true for sessions started before the feature.
  mulligans?: number
  opening_hand_kept?: boolean
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
  commander_card_id?: string | null
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
  attacker_power?: number
  attacker_toughness?: number
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

// A resolution-time / announcement-time choice a player must make before a stack
// item can (continue to) resolve. Mirrors public.get_pending_decisions.
export type PendingDecision = {
  id: string
  deciding_player_id: string
  source_stack_item_id: string | null
  decision_type: 'choose_mode' | 'scry' | 'surveil' | string
  prompt: string | null
  options: unknown
  min_choices: number
  max_choices: number
  // Decision-specific context (mig 286): divide_damage carries
  // {amount, max_targets}; pay_x_mana_damage carries {color}.
  params: Record<string, unknown> | null
}

// One revealed card in a scry / surveil decision's options array.
export type ScryOption = {
  game_card_id: string
  name: string
  library_position: number
}

// One mode in a choose_mode decision's options array.
export type ModalModeOption = {
  label?: string
  actions?: { type?: string; target_type?: unknown }[]
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
  oracle_text?: string | null
  oracle_id?: string | null
  keywords?: string[] | null
  power?: number | null
  toughness?: number | null
  power_toughness?: string | null
  is_token?: boolean | null
}

// A full catalog card row, as returned by set_card_script.
export type CardCatalogEntry = LinkedCard

export type TokenCard = {
  id: string
  name: string | null
  type_line: string | null
  power_toughness: string | null
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
  mana_cost?: string | null
  power_toughness?: string | null
  controller_player_id?: string | null
  is_face_down?: boolean | null
  plus_one_counters?: number
  // Non-+1/+1 counter bag (charge/quest/…). Empty when none.
  counters?: Record<string, number> | null
  pump_power?: number
  pump_toughness?: number
  // Colours this card has protection from (white|blue|black|red|green).
  protection_colors?: string[]
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
  plus_one_counters?: number
  counters?: Record<string, number> | null
  pump_power?: number
  pump_toughness?: number
  is_commander?: boolean
  command_zone_casts?: number
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
  plus_one_counters?: number
  counters?: Record<string, number> | null
}

export type SupabaseErrorLike = {
  code?: string
  details?: string
  hint?: string
  message?: string
}
