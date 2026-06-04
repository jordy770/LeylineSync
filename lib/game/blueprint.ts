import type { SupabaseClient } from '@supabase/supabase-js'
import {
  advanceStep as advanceStepAction,
  castCardFromHand,
  declareAttacker as declareAttackerAction,
  declareBlocker as declareBlockerAction,
  passPriority as passPriorityAction,
  resolveCombatDamage,
} from './actions'
import { emptyManaPool, normalizeManaPool } from './data'
import type {
  CombatAssignment,
  CombatDamageResult,
  GameSession,
  GameSessionPlayer,
  GameTurnState,
  GameZone,
  ManaPool,
  StackItem,
  TurnStep,
} from './types'

export type GameViewStep = TurnStep

export type BoardLayoutKey =
  | 'beginning'
  | 'main'
  | 'combat_start'
  | 'declare_attackers'
  | 'declare_blockers'
  | 'combat_damage'
  | 'stack_priority'
  | 'end_step'
  | 'finished'

export type PriorityRole = 'active_player' | 'non_active_player' | 'none'

export type StackActionType = 'deal_damage_player' | 'counter_spell' | string

export type GameStateTable =
  | 'game_sessions'
  | 'game_turn_state'
  | 'game_session_players'
  | 'game_players'
  | 'cards'
  | 'game_cards'
  | 'game_stack_items'
  | 'game_combat_assignments'
  | 'game_combat_blockers'

export type GameRpcName =
  | 'create_game_session'
  | 'join_game_session'
  | 'lock_game_session'
  | 'finish_game_session'
  | 'initialize_turn_state'
  | 'get_turn_state'
  | 'advance_step'
  | 'pass_priority'
  | 'draw_card'
  | 'untap_all'
  | 'move_card_to_zone'
  | 'set_card_tapped'
  | 'cast_card_from_hand'
  | 'add_mana_from_card'
  | 'clear_mana_pool'
  | 'create_mana_retention_effect'
  | 'get_stack_items'
  | 'put_action_on_stack'
  | 'resolve_top_of_stack'
  | 'declare_attacker'
  | 'declare_blocker'
  | 'set_combat_blocker_order'
  | 'clear_combat_assignments'
  | 'resolve_combat_damage'
  | 'get_combat_action_state'
  | 'get_combat_assignments'

export type GameEdgeFunctionName = 'spawn-deck'

export interface ZoneCardRef {
  cardId: string
  gameCardId: string
  ownerPlayerId: string
  controllerPlayerId: string
  zone: GameZone
  zonePosition: number
  visibleToPlayerIds: string[]
}

export interface BattlefieldPermanent {
  cardId: string
  gameCardId: string
  controllerPlayerId: string
  tapped: boolean
  attackingAssignmentId?: string
  blockingAssignmentId?: string
  damageMarked: number
}

export interface PlayerZones {
  libraryCount: number
  hand: ZoneCardRef[]
  battlefield: BattlefieldPermanent[]
  graveyard: string[]
  exile: string[]
}

export interface GameCardSnapshot {
  id: string
  card_id: string
  owner_id: string
  controller_player_id?: string | null
  zone: GameZone
  zone_position?: number | null
  is_tapped: boolean
  damage_marked?: number | null
}

export interface GameLoopState {
  session: GameSession | null
  turn: GameTurnState | null
  currentPlayerId: string | null
  players: GameSessionPlayer[]
  zonesByPlayer: Record<string, PlayerZones>
  stack: StackItem[]
  combat: CombatAssignment[]
  manaPools: Record<string, ManaPool>
}

export interface GameLoopSnapshotInput {
  session: GameSession | null
  turn: GameTurnState | null
  currentPlayerId: string | null
  players: GameSessionPlayer[]
  cards: GameCardSnapshot[]
  stack: StackItem[]
  combat: CombatAssignment[]
  manaPools: Record<string, ManaPool>
}

export interface GameLoopActions {
  passPriority(): Promise<GameTurnState>
  declareAttacker(cardId: string, targetPlayerId: string): Promise<CombatAssignment>
  declareBlocker(blockerCardId: string, attackingCardId: string): Promise<CombatAssignment>
  castSpell(cardId: string): Promise<unknown>
  activateAbility(cardId: string, abilityId: string): Promise<StackItem | ManaPool | unknown>
  submitPhaseAction(): Promise<GameTurnState | CombatDamageResult>
}

export const gameStateTables: readonly GameStateTable[] = [
  'game_sessions',
  'game_turn_state',
  'game_session_players',
  'game_players',
  'cards',
  'game_cards',
  'game_stack_items',
  'game_combat_assignments',
  'game_combat_blockers',
] as const

export const gameRpcNames: readonly GameRpcName[] = [
  'create_game_session',
  'join_game_session',
  'lock_game_session',
  'finish_game_session',
  'initialize_turn_state',
  'get_turn_state',
  'advance_step',
  'pass_priority',
  'draw_card',
  'untap_all',
  'move_card_to_zone',
  'set_card_tapped',
  'cast_card_from_hand',
  'add_mana_from_card',
  'clear_mana_pool',
  'create_mana_retention_effect',
  'get_stack_items',
  'put_action_on_stack',
  'resolve_top_of_stack',
  'declare_attacker',
  'declare_blocker',
  'set_combat_blocker_order',
  'clear_combat_assignments',
  'resolve_combat_damage',
  'get_combat_action_state',
  'get_combat_assignments',
] as const

export const gameEdgeFunctionNames: readonly GameEdgeFunctionName[] = ['spawn-deck'] as const

const emptyPlayerZones: PlayerZones = {
  libraryCount: 0,
  hand: [],
  battlefield: [],
  graveyard: [],
  exile: [],
}

export function createGameLoopState(input: GameLoopSnapshotInput): GameLoopState {
  return {
    session: input.session,
    turn: input.turn,
    currentPlayerId: input.currentPlayerId,
    players: input.players,
    zonesByPlayer: buildZonesByPlayer(input.players, input.cards, input.combat),
    stack: input.stack,
    combat: input.combat,
    manaPools: normalizeManaPools(input.players, input.manaPools),
  }
}

export function selectBoardLayoutKey(state: GameLoopState): BoardLayoutKey {
  if (state.session?.status === 'finished') {
    return 'finished'
  }

  if (selectPendingStackCount(state) > 0) {
    return 'stack_priority'
  }

  switch (state.turn?.step) {
    case 'untap':
    case 'upkeep':
    case 'draw':
      return 'beginning'
    case 'precombat_main':
    case 'postcombat_main':
      return 'main'
    case 'beginning_of_combat':
      return 'combat_start'
    case 'declare_attackers':
      return 'declare_attackers'
    case 'declare_blockers':
      return 'declare_blockers'
    case 'combat_damage':
    case 'end_of_combat':
      return 'combat_damage'
    case 'end':
    case 'cleanup':
      return 'end_step'
    default:
      return 'beginning'
  }
}

export function selectPriorityRole(state: GameLoopState): PriorityRole {
  if (!state.currentPlayerId || !state.turn) {
    return 'none'
  }

  const priorityPlayerId = state.turn.priority_player_id ?? state.turn.active_player_id
  if (priorityPlayerId !== state.currentPlayerId) {
    return 'none'
  }

  return state.turn.active_player_id === state.currentPlayerId ? 'active_player' : 'non_active_player'
}

export function selectCanDeclareAttackers(state: GameLoopState): boolean {
  return Boolean(
    state.currentPlayerId &&
      state.turn?.step === 'declare_attackers' &&
      state.turn.active_player_id === state.currentPlayerId &&
      selectPendingStackCount(state) === 0,
  )
}

export function selectCanDeclareBlockers(state: GameLoopState): boolean {
  return Boolean(
    state.currentPlayerId &&
      state.turn?.step === 'declare_blockers' &&
      state.turn.active_player_id !== state.currentPlayerId &&
      selectPendingStackCount(state) === 0 &&
      state.combat.length > 0,
  )
}

export function selectPendingStackCount(state: GameLoopState): number {
  return state.stack.filter((item) => item.status === 'pending').length
}

export function selectPlayerZoneSummary(state: GameLoopState, playerId: string): PlayerZones {
  return state.zonesByPlayer[playerId] ?? emptyPlayerZones
}

export function createGameLoopActions({
  supabase,
  sessionId,
  getState,
}: {
  supabase: SupabaseClient
  sessionId: string
  getState: () => GameLoopState
}): GameLoopActions {
  return {
    passPriority() {
      return passPriorityAction(supabase, sessionId)
    },
    declareAttacker(cardId, targetPlayerId) {
      return declareAttackerAction(supabase, sessionId, cardId, targetPlayerId)
    },
    declareBlocker(blockerCardId, attackingCardId) {
      return declareBlockerAction(supabase, sessionId, blockerCardId, attackingCardId)
    },
    castSpell(cardId) {
      return castCardFromHand(supabase, sessionId, cardId)
    },
    activateAbility(cardId, abilityId) {
      return putAbilityOnStack(supabase, sessionId, cardId, abilityId)
    },
    submitPhaseAction() {
      const state = getState()
      if (state.turn?.step === 'combat_damage') {
        return resolveCombatDamage(supabase, sessionId)
      }

      return advanceStepAction(supabase, sessionId)
    },
  }
}

async function putAbilityOnStack(
  supabase: SupabaseClient,
  sessionId: string,
  cardId: string,
  abilityId: string,
) {
  const { data, error } = await supabase.rpc('put_action_on_stack', {
    p_session_id: sessionId,
    p_action_type: abilityId,
    p_payload: {
      ability_id: abilityId,
    },
    p_source_card_id: cardId,
  })

  if (error) {
    throw error
  }

  return data as StackItem
}

function buildZonesByPlayer(
  players: GameSessionPlayer[],
  cards: GameCardSnapshot[],
  combat: CombatAssignment[],
) {
  const zonesByPlayer: Record<string, PlayerZones> = {}
  const attackAssignmentByCardId = new Map(combat.map((assignment) => [assignment.attacker_card_id, assignment.id]))
  const blockAssignmentByCardId = new Map<string, string>()

  for (const assignment of combat) {
    if (assignment.blocker_card_id) {
      blockAssignmentByCardId.set(assignment.blocker_card_id, assignment.id)
    }

    for (const blocker of assignment.blockers ?? []) {
      blockAssignmentByCardId.set(blocker.blocker_card_id, assignment.id)
    }
  }

  for (const player of players) {
    zonesByPlayer[player.player_id] = {
      libraryCount: 0,
      hand: [],
      battlefield: [],
      graveyard: [],
      exile: [],
    }
  }

  for (const card of cards) {
    const controllerPlayerId = card.controller_player_id ?? card.owner_id
    const ownerZones = getOrCreatePlayerZones(zonesByPlayer, card.owner_id)

    if (card.zone === 'library') {
      ownerZones.libraryCount += 1
      continue
    }

    if (card.zone === 'hand') {
      ownerZones.hand.push({
        cardId: card.card_id,
        gameCardId: card.id,
        ownerPlayerId: card.owner_id,
        controllerPlayerId,
        zone: card.zone,
        zonePosition: card.zone_position ?? 0,
        visibleToPlayerIds: [card.owner_id],
      })
      continue
    }

    if (card.zone === 'graveyard') {
      ownerZones.graveyard.push(card.id)
      continue
    }

    if (card.zone === 'exile') {
      ownerZones.exile.push(card.id)
      continue
    }

    if (card.zone === 'battlefield') {
      const controllerZones = getOrCreatePlayerZones(zonesByPlayer, controllerPlayerId)
      controllerZones.battlefield.push({
        cardId: card.card_id,
        gameCardId: card.id,
        controllerPlayerId,
        tapped: card.is_tapped,
        attackingAssignmentId: attackAssignmentByCardId.get(card.id),
        blockingAssignmentId: blockAssignmentByCardId.get(card.id),
        damageMarked: card.damage_marked ?? 0,
      })
    }
  }

  for (const zones of Object.values(zonesByPlayer)) {
    zones.hand.sort((left, right) => left.zonePosition - right.zonePosition)
  }

  return zonesByPlayer
}

function getOrCreatePlayerZones(zonesByPlayer: Record<string, PlayerZones>, playerId: string) {
  zonesByPlayer[playerId] ??= {
    libraryCount: 0,
    hand: [],
    battlefield: [],
    graveyard: [],
    exile: [],
  }

  return zonesByPlayer[playerId]
}

function normalizeManaPools(players: GameSessionPlayer[], manaPools: Record<string, ManaPool>) {
  const normalized: Record<string, ManaPool> = {}

  for (const player of players) {
    normalized[player.player_id] = normalizeManaPool(manaPools[player.player_id] ?? emptyManaPool)
  }

  return normalized
}
