import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  BoardCard,
  ControllerCard,
  GameCardInstanceRow,
  GameSession,
  GameSessionPlayer,
  GameSessionStatus,
  GameTurnState,
  GameZone,
  LinkedCard,
  ManaPool,
  TurnPhase,
  TurnStep,
} from './types'

export const emptyManaPool: ManaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }
export const gameZones = ['library', 'hand', 'battlefield', 'graveyard', 'exile'] as const
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
      zone,
      zone_position
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
    'id, name, script, type_line',
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
      zone: normalizeGameZone(card.zone),
      zone_position: card.zone_position ?? 0,
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
  const { data, error } = await supabase
    .from('game_turn_state')
    .select('session_id, active_player_id, turn_number, phase, step, created_at, updated_at')
    .eq('session_id', sessionId)
    .maybeSingle()

  if (error) {
    throw error
  }

  return data ? normalizeTurnState(data as Partial<GameTurnState>) : null
}

export async function getGameSession(supabase: SupabaseClient, sessionId: string) {
  const { data, error } = await supabase
    .from('game_sessions')
    .select('id, status, created_by, created_at, locked_at, finished_at')
    .eq('id', sessionId)
    .maybeSingle()

  if (error) {
    throw error
  }

  return data ? normalizeGameSession(data as Partial<GameSession>) : null
}

export async function getGameSessionPlayers(supabase: SupabaseClient, sessionId: string) {
  const { data, error } = await supabase
    .from('game_session_players')
    .select('session_id, player_id, seat_number, life_total, joined_at')
    .eq('session_id', sessionId)
    .order('seat_number', { ascending: true })

  if (error) {
    throw error
  }

  return (data ?? []) as GameSessionPlayer[]
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
