import type { SupabaseClient } from '@supabase/supabase-js'
import type { GameTurnState, GameZone, ManaPool, SupabaseErrorLike } from './types'

export function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }

  if (isSupabaseErrorLike(error)) {
    return [error.message, error.code ? `Code: ${error.code}` : null, error.details, error.hint]
      .filter(Boolean)
      .join(' ')
  }

  return 'Er is een onbekende fout opgetreden'
}

export async function setCardTapped(
  supabase: SupabaseClient,
  cardId: string,
  isTapped: boolean,
) {
  const { error } = await supabase.from('game_cards').update({ is_tapped: isTapped }).eq('id', cardId)

  if (error) {
    throw error
  }
}

export async function moveCardToZone(
  supabase: SupabaseClient,
  cardId: string,
  zone: GameZone,
) {
  const { error } = await supabase.rpc('move_card_to_zone', {
    p_game_card_id: cardId,
    p_zone: zone,
  })

  if (error) {
    throw error
  }
}

export async function drawCard(
  supabase: SupabaseClient,
  sessionId: string,
  playerId: string,
) {
  const { data, error } = await supabase.rpc('draw_card', {
    p_session_id: sessionId,
    p_player_id: playerId,
  })

  if (error) {
    throw error
  }

  return data as string
}

export async function untapAll(
  supabase: SupabaseClient,
  sessionId: string,
  playerId: string,
) {
  const { data, error } = await supabase.rpc('untap_all', {
    p_session_id: sessionId,
    p_player_id: playerId,
  })

  if (error) {
    throw error
  }

  return data as number
}

export async function clearManaPool(
  supabase: SupabaseClient,
  sessionId: string,
  playerId: string,
) {
  const { data, error } = await supabase.rpc('clear_mana_pool', {
    p_session_id: sessionId,
    p_player_id: playerId,
  })

  if (error) {
    throw error
  }

  return data as ManaPool
}

export async function initializeTurnState(
  supabase: SupabaseClient,
  sessionId: string,
  activePlayerId: string,
) {
  const { data, error } = await supabase.rpc('initialize_turn_state', {
    p_session_id: sessionId,
    p_active_player_id: activePlayerId,
  })

  if (error) {
    throw error
  }

  return data as GameTurnState
}

export async function advanceStep(supabase: SupabaseClient, sessionId: string) {
  const { data, error } = await supabase.rpc('advance_step', {
    p_session_id: sessionId,
  })

  if (error) {
    throw error
  }

  return data as GameTurnState
}

export async function createGameSession(supabase: SupabaseClient) {
  const { data, error } = await supabase.rpc('create_game_session')

  if (error) {
    throw error
  }

  return data as string
}

export async function joinGameSession(supabase: SupabaseClient, sessionId: string) {
  const { data, error } = await supabase.rpc('join_game_session', {
    p_session_id: sessionId,
  })

  if (error) {
    throw error
  }

  return data as number
}

export async function lockGameSession(supabase: SupabaseClient, sessionId: string) {
  const { data, error } = await supabase.rpc('lock_game_session', {
    p_session_id: sessionId,
  })

  if (error) {
    throw error
  }

  return data as boolean
}

export async function spawnDeckForSession(
  supabase: SupabaseClient,
  sessionId: string,
  deckId: string,
) {
  const { data, error, response } = await supabase.functions.invoke('spawn-deck', {
    body: {
      sessionId,
      deckId,
    },
  })

  if (error) {
    const functionErrorMessage = await getFunctionErrorMessage(response)
    if (functionErrorMessage) {
      throw new Error(functionErrorMessage)
    }

    throw error
  }

  return data as { message: string; count: number }
}

export async function addManaFromCard({
  supabase,
  cardId,
  sessionId,
  playerId,
  color,
  amount,
  shouldTapCard,
}: {
  supabase: SupabaseClient
  cardId: string
  sessionId: string
  playerId: string
  color: string
  amount: number
  shouldTapCard: boolean
}) {
  const { data, error } = await supabase.rpc('add_mana_from_card', {
    p_game_card_id: cardId,
    p_session_id: sessionId,
    p_player_id: playerId,
    p_color: color,
    p_amount: amount,
    p_should_tap_card: shouldTapCard,
  })

  if (error) {
    throw error
  }

  return data as ManaPool
}

function isSupabaseErrorLike(error: unknown): error is SupabaseErrorLike {
  return typeof error === 'object' && error !== null && 'message' in error
}

async function getFunctionErrorMessage(response: Response | undefined) {
  if (!response) {
    return null
  }

  try {
    const payload = (await response.clone().json()) as { error?: string }
    return payload.error ?? null
  } catch {
    try {
      const text = await response.clone().text()
      return text || null
    } catch {
      return null
    }
  }
}
