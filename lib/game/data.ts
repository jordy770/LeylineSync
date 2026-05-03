import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  BoardCard,
  CombatActionState,
  CombatAssignment,
  CardCatalogFilters,
  ControllerCard,
  GameCardInstanceRow,
  GameSession,
  GameSessionPlayer,
  GameSessionStatus,
  GameTurnState,
  GameZone,
  LinkedCard,
  ManaPool,
  StackItem,
  TurnPhase,
  TurnStep,
} from './types'

export const emptyManaPool: ManaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }
export const gameZones = ['library', 'hand', 'stack', 'battlefield', 'graveyard', 'exile'] as const
export const gameSessionStatuses = ['open', 'locked', 'finished'] as const
export const turnPhases = ['beginning', 'main_1', 'combat', 'main_2', 'ending'] as const
export const turnSteps = [
  'untap',
  'upkeep',
  'draw',
  'precombat_main',
  'beginning_of_combat',
  'declare_attackers',
  'declare_blockers',
  'combat_damage',
  'end_of_combat',
  'postcombat_main',
  'end',
  'cleanup',
] as const

export async function getCurrentPlayerId(supabase: SupabaseClient) {
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()

  if (error) {
    throw error
  }

  return user?.id ?? null
}

export async function getBoardCards(supabase: SupabaseClient, sessionId: string) {
  const { data, error } = await supabase
    .from('game_cards')
    .select(`
      id,
      card_id,
      position_x,
      position_y,
      is_tapped,
      damage_marked,
      zone
    `)
    .eq('session_id', sessionId)
    .eq('zone', 'battlefield')

  if (error) {
    throw error
  }

  const gameCardRows = (data ?? []) as GameCardInstanceRow[]
  const linkedCardsById = await getLinkedCardsById(
    supabase,
    gameCardRows.map((card) => card.card_id),
    'id, name, image_url',
  )

  return gameCardRows.map<BoardCard>((item) => {
    const linkedCard = linkedCardsById.get(item.card_id) ?? null

    return {
      id: item.id,
      card_id: item.card_id,
      position_x: item.position_x ?? 0,
      position_y: item.position_y ?? 0,
      is_tapped: item.is_tapped,
      damage_marked: item.damage_marked ?? 0,
      zone: normalizeGameZone(item.zone),
      name: linkedCard?.name || 'Unknown',
      image_url: linkedCard?.image_url ?? null,
    }
  })
}

export async function getControllerCards(
  supabase: SupabaseClient,
  sessionId: string,
  playerId: string,
) {
  const { data, error } = await supabase
    .from('game_cards')
    .select(`
      id,
      card_id,
      is_tapped,
      damage_marked,
      zone,
      zone_position,
      controller_player_id,
      copied_script,
      static_effects_suppressed,
      entered_battlefield_turn_number
    `)
    .eq('session_id', sessionId)
    .eq('owner_id', playerId)

  if (error) {
    throw error
  }

  const gameCardRows = (data ?? []) as GameCardInstanceRow[]
    const linkedCardsById = await getLinkedCardsById(
      supabase,
      gameCardRows.map((card) => card.card_id),
      'id, name, image_url, script, type_line, mana_cost, keywords, power, toughness, power_toughness',
    )

  const missingCardIds = getUniqueCardIds(gameCardRows.map((card) => card.card_id)).filter(
    (cardId) => !linkedCardsById.has(cardId),
  )

  const cards = gameCardRows.map<ControllerCard>((card) => {
    const linkedCard = linkedCardsById.get(card.card_id) ?? null

    return {
      id: card.id,
      card_id: card.card_id,
      is_tapped: card.is_tapped,
      damage_marked: card.damage_marked ?? 0,
      zone: normalizeGameZone(card.zone),
      zone_position: card.zone_position ?? 0,
      controller_player_id: card.controller_player_id ?? null,
      copied_script: card.copied_script ?? null,
      static_effects_suppressed: card.static_effects_suppressed ?? false,
      entered_battlefield_turn_number: card.entered_battlefield_turn_number ?? null,
      name: linkedCard?.name ?? `Unknown (${card.card_id})`,
      cards: linkedCard,
    }
  })

  return {
    cards,
    rowCount: gameCardRows.length,
    missingCardIds,
  }
}

export async function getPlayerManaPool(
  supabase: SupabaseClient,
  sessionId: string,
  playerId: string,
) {
  const { data, error } = await supabase
    .from('game_players')
    .select('mana_pool')
    .eq('session_id', sessionId)
    .eq('player_id', playerId)
    .maybeSingle()

  if (error) {
    throw error
  }

  return normalizeManaPool((data?.mana_pool as ManaPool | null) ?? null)
}

export async function getTurnState(supabase: SupabaseClient, sessionId: string) {
  const { data, error } = await supabase.rpc('get_turn_state', {
    p_session_id: sessionId,
  })

  if (error) {
    throw error
  }

  const turnState = Array.isArray(data) ? data[0] : data

  return turnState ? normalizeTurnState(turnState as Partial<GameTurnState>) : null
}

export async function getGameSession(supabase: SupabaseClient, sessionId: string) {
  const { data, error } = await supabase
    .from('game_sessions')
    .select('id, status, created_by, created_at, locked_at, finished_at, winner_player_id')
    .eq('id', sessionId)
    .maybeSingle()

  if (error) {
    throw error
  }

  return data ? normalizeGameSession(data as Partial<GameSession>) : null
}

export async function getGameSessionPlayers(supabase: SupabaseClient, sessionId: string) {
  const { data, error } = await supabase.rpc('get_session_players', {
    p_session_id: sessionId,
  })

  if (error) {
    throw error
  }

  return (data ?? []) as GameSessionPlayer[]
}

export async function getCombatAssignments(supabase: SupabaseClient, sessionId: string) {
  const { data, error } = await supabase.rpc('get_combat_assignments', {
    p_session_id: sessionId,
  })

  if (error) {
    throw error
  }

  return (data ?? []) as CombatAssignment[]
}

export async function getCombatActionState(supabase: SupabaseClient, sessionId: string) {
  const { data, error } = await supabase.rpc('get_combat_action_state', {
    p_session_id: sessionId,
  })

  if (error) {
    throw error
  }

  return data as CombatActionState
}

export async function getStackItems(supabase: SupabaseClient, sessionId: string) {
  const { data, error } = await supabase.rpc('get_stack_items', {
    p_session_id: sessionId,
  })

  if (error) {
    throw error
  }

  return (data ?? []) as StackItem[]
}

export async function getCurrentPlayerSessions(supabase: SupabaseClient) {
  const playerId = await getCurrentPlayerId(supabase)

  if (!playerId) {
    return []
  }

  const { data, error } = await supabase
    .from('game_session_players')
    .select('session_id')
    .eq('player_id', playerId)

  if (error) {
    throw error
  }

  const sessionIds = [...new Set((data ?? []).map((row) => row.session_id).filter(Boolean))]

  if (sessionIds.length === 0) {
    return []
  }

  const { data: sessions, error: sessionsError } = await supabase
    .from('game_sessions')
    .select('id, status, created_by, created_at, locked_at, finished_at, winner_player_id')
    .in('id', sessionIds)
    .order('created_at', { ascending: false })

  if (sessionsError) {
    throw sessionsError
  }

  return ((sessions ?? []) as Partial<GameSession>[]).map(normalizeGameSession)
}

export async function getCardCatalog(
  supabase: SupabaseClient,
  filters: CardCatalogFilters | string = '',
) {
  const normalizedFilters: CardCatalogFilters =
    typeof filters === 'string' ? { search: filters } : filters
  const limit = Math.min(Math.max(normalizedFilters.limit ?? 80, 1), 200)

  let query = supabase
    .from('cards')
    .select('id, name, image_url, type_line, mana_cost, keywords, power, toughness, power_toughness')
    .order('name', { ascending: true })
    .limit(limit)

  const trimmedSearch = normalizedFilters.search?.trim() ?? ''

  if (trimmedSearch) {
    query = query.ilike('name', `%${trimmedSearch}%`)
  }

  if (normalizedFilters.type && normalizedFilters.type !== 'all') {
    query = query.ilike('type_line', `%${normalizedFilters.type}%`)
  }

  if (normalizedFilters.color && normalizedFilters.color !== 'all') {
    query = query.ilike('mana_cost', `%{${normalizedFilters.color}}%`)
  }

  if (normalizedFilters.keyword) {
    query = query.contains('keywords', [normalizedFilters.keyword])
  }

  const { data, error } = await query

  if (error) {
    throw error
  }

  return (data ?? []) as LinkedCard[]
}

export function normalizeManaPool(pool: ManaPool | null | undefined): ManaPool {
  return {
    ...emptyManaPool,
    ...(pool ?? {}),
  }
}

export function normalizeGameZone(zone: string | null | undefined): GameZone {
  return gameZones.includes(zone as GameZone) ? (zone as GameZone) : 'battlefield'
}

export function normalizeGameSession(session: Partial<GameSession>): GameSession {
  return {
    id: session.id ?? '',
    status: normalizeGameSessionStatus(session.status),
    created_by: session.created_by ?? '',
    created_at: session.created_at,
    locked_at: session.locked_at ?? null,
    finished_at: session.finished_at ?? null,
    winner_player_id: session.winner_player_id ?? null,
  }
}

export function normalizeGameSessionStatus(status: string | null | undefined): GameSessionStatus {
  return gameSessionStatuses.includes(status as GameSessionStatus)
    ? (status as GameSessionStatus)
    : 'open'
}

export function normalizeTurnState(state: Partial<GameTurnState>): GameTurnState {
  return {
    session_id: state.session_id ?? '',
    active_player_id: state.active_player_id ?? '',
    active_username: state.active_username ?? null,
    priority_player_id: state.priority_player_id ?? state.active_player_id ?? '',
    priority_username: state.priority_username ?? state.active_username ?? null,
    priority_cycle_started_by: state.priority_cycle_started_by ?? null,
    priority_pass_count: state.priority_pass_count ?? 0,
    lands_played_this_turn: state.lands_played_this_turn ?? 0,
    land_play_limit: state.land_play_limit ?? 1,
    turn_number: state.turn_number ?? 1,
    phase: normalizeTurnPhase(state.phase),
    step: normalizeTurnStep(state.step),
    created_at: state.created_at,
    updated_at: state.updated_at,
  }
}

export function normalizeTurnPhase(phase: string | null | undefined): TurnPhase {
  return turnPhases.includes(phase as TurnPhase) ? (phase as TurnPhase) : 'beginning'
}

export function normalizeTurnStep(step: string | null | undefined): TurnStep {
  return turnSteps.includes(step as TurnStep) ? (step as TurnStep) : 'untap'
}

async function getLinkedCardsById(
  supabase: SupabaseClient,
  cardIds: string[],
  columns: string,
) {
  const uniqueCardIds = getUniqueCardIds(cardIds)

  if (uniqueCardIds.length === 0) {
    return new Map<string, LinkedCard>()
  }

  const { data, error } = await supabase.from('cards').select(columns).in('id', uniqueCardIds)

  if (error) {
    throw error
  }

  return new Map(((data ?? []) as unknown as LinkedCard[]).map((card) => [card.id, card]))
}

function getUniqueCardIds(cardIds: string[]) {
  return [...new Set(cardIds.filter(Boolean))]
}
