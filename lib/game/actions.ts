import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CardScript,
  CombatAssignment,
  CombatDamageResult,
  DeckImportResult,
  GameSessionPlayer,
  GameActionLog,
  GameTurnState,
  GameZone,
  ManaPool,
  StackItem,
  SupabaseErrorLike,
} from './types'

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
  const { error } = await supabase.rpc('set_card_tapped', {
    p_game_card_id: cardId,
    p_is_tapped: isTapped,
  })

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

export async function castCardFromHand(
  supabase: SupabaseClient,
  sessionId: string,
  cardId: string,
  genericPayment?: Record<string, number>,
) {
  const { data, error } = await supabase.rpc('cast_card_from_hand', {
    p_session_id: sessionId,
    p_game_card_id: cardId,
    p_generic_payment: genericPayment ?? null,
  })

  if (error) {
    throw error
  }

  return data
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

export async function devDrawCard(
  supabase: SupabaseClient,
  sessionId: string,
  playerId: string,
) {
  const { data, error } = await supabase.rpc('dev_draw_card', {
    p_session_id: sessionId,
    p_player_id: playerId,
  })

  if (error) {
    throw error
  }

  return data as string
}

export async function devUndoLastDraw(
  supabase: SupabaseClient,
  sessionId: string,
  playerId: string,
) {
  const { data, error } = await supabase.rpc('dev_undo_last_draw', {
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

export async function devUntapAll(
  supabase: SupabaseClient,
  sessionId: string,
  playerId: string,
) {
  const { data, error } = await supabase.rpc('dev_untap_all', {
    p_session_id: sessionId,
    p_player_id: playerId,
  })

  if (error) {
    throw error
  }

  return data as number
}

export async function devClearManaPool(
  supabase: SupabaseClient,
  sessionId: string,
  playerId: string,
) {
  const { data, error } = await supabase.rpc('dev_clear_mana_pool', {
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

export async function passPriority(supabase: SupabaseClient, sessionId: string) {
  const { data, error } = await supabase.rpc('pass_priority', {
    p_session_id: sessionId,
  })

  if (error) {
    throw error
  }

  return data as GameTurnState
}

export async function putDealDamagePlayerOnStack(
  supabase: SupabaseClient,
  sessionId: string,
  targetPlayerId: string,
  amount: number,
  timing: 'instant' | 'sorcery',
  sourceCardId?: string | null,
  genericPayment?: Record<string, number>,
) {
  const { data, error } = await supabase.rpc('put_action_on_stack', {
    p_session_id: sessionId,
    p_action_type: 'deal_damage_player',
    p_payload: {
      target_player_id: targetPlayerId,
      amount,
      timing,
      generic_payment: genericPayment ?? null,
    },
    p_source_card_id: sourceCardId ?? null,
  })

  if (error) {
    throw error
  }

  return data as StackItem
}

export async function putDealDamageCreatureOnStack(
  supabase: SupabaseClient,
  sessionId: string,
  targetCardId: string,
  amount: number,
  timing: 'instant' | 'sorcery',
  sourceCardId?: string | null,
  genericPayment?: Record<string, number>,
) {
  const { data, error } = await supabase.rpc('put_action_on_stack', {
    p_session_id: sessionId,
    p_action_type: 'deal_damage_creature',
    p_payload: {
      target_card_id: targetCardId,
      amount,
      timing,
      generic_payment: genericPayment ?? null,
    },
    p_source_card_id: sourceCardId ?? null,
  })

  if (error) {
    throw error
  }

  return data as StackItem
}

export async function putPumpCreatureOnStack(
  supabase: SupabaseClient,
  sessionId: string,
  targetCardId: string,
  power: number,
  toughness: number,
  timing: 'instant' | 'sorcery',
  sourceCardId?: string | null,
  genericPayment?: Record<string, number>,
) {
  const { data, error } = await supabase.rpc('put_action_on_stack', {
    p_session_id: sessionId,
    p_action_type: 'pump_creature',
    p_payload: {
      target_card_id: targetCardId,
      power,
      toughness,
      timing,
      generic_payment: genericPayment ?? null,
    },
    p_source_card_id: sourceCardId ?? null,
  })

  if (error) {
    throw error
  }

  return data as StackItem
}

export async function putCounterSpellOnStack(
  supabase: SupabaseClient,
  sessionId: string,
  targetStackItemId: string,
  sourceCardId: string,
  genericPayment?: Record<string, number>,
) {
  const { data, error } = await supabase.rpc('put_action_on_stack', {
    p_session_id: sessionId,
    p_action_type: 'counter_spell',
    p_payload: {
      target_stack_item_id: targetStackItemId,
      timing: 'instant',
      generic_payment: genericPayment ?? null,
    },
    p_source_card_id: sourceCardId,
  })

  if (error) {
    throw error
  }

  return data as StackItem
}

export async function createManaRetentionEffect({
  supabase,
  sessionId,
  sourceCardId,
  playerId,
  colors,
  expiresAtPhase = 'ending',
  expiresAtStep = 'cleanup',
  shouldTapCard,
}: {
  supabase: SupabaseClient
  sessionId: string
  sourceCardId: string
  playerId: string
  colors: string[]
  expiresAtPhase?: string
  expiresAtStep?: string
  shouldTapCard: boolean
}) {
  const { data, error } = await supabase.rpc('create_mana_retention_effect', {
    p_session_id: sessionId,
    p_source_card_id: sourceCardId,
    p_colors: colors,
    p_affected_player_id: playerId,
    p_expires_at_phase: expiresAtPhase,
    p_expires_at_step: expiresAtStep,
    p_should_tap_card: shouldTapCard,
  })

  if (error) {
    throw error
  }

  return data
}

export async function rebuildScriptedContinuousEffects(
  supabase: SupabaseClient,
  sessionId: string,
) {
  const { data, error } = await supabase.rpc('rebuild_scripted_continuous_effects', {
    p_session_id: sessionId,
  })

  if (error) {
    throw error
  }

  return data as number
}

export async function setCardController(
  supabase: SupabaseClient,
  cardId: string,
  controllerPlayerId: string,
) {
  const { data, error } = await supabase.rpc('set_card_controller', {
    p_game_card_id: cardId,
    p_controller_player_id: controllerPlayerId,
  })

  if (error) {
    throw error
  }

  return data
}

export async function setCardCopiedScript(
  supabase: SupabaseClient,
  cardId: string,
  copiedScript: CardScript | null,
) {
  const { data, error } = await supabase.rpc('set_card_copied_script', {
    p_game_card_id: cardId,
    p_copied_script: copiedScript,
  })

  if (error) {
    throw error
  }

  return data
}

export async function setCardStaticEffectsSuppressed(
  supabase: SupabaseClient,
  cardId: string,
  suppressed: boolean,
) {
  const { data, error } = await supabase.rpc('set_card_static_effects_suppressed', {
    p_game_card_id: cardId,
    p_suppressed: suppressed,
  })

  if (error) {
    throw error
  }

  return data
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

export async function finishGameSession(supabase: SupabaseClient, sessionId: string) {
  const { data, error } = await supabase.rpc('finish_game_session', {
    p_session_id: sessionId,
  })

  if (error) {
    throw error
  }

  return data as boolean
}

export async function adjustPlayerLife(
  supabase: SupabaseClient,
  sessionId: string,
  targetPlayerId: string,
  delta: number,
) {
  const { data, error } = await supabase.rpc('adjust_player_life', {
    p_session_id: sessionId,
    p_target_player_id: targetPlayerId,
    p_delta: delta,
  })

  if (error) {
    throw error
  }

  return data as GameSessionPlayer
}

export async function declareAttacker(
  supabase: SupabaseClient,
  sessionId: string,
  attackerCardId: string,
  defendingPlayerId: string,
) {
  const { data, error } = await supabase.rpc('declare_attacker', {
    p_session_id: sessionId,
    p_attacker_card_id: attackerCardId,
    p_defending_player_id: defendingPlayerId,
  })

  if (error) {
    throw error
  }

  return data as CombatAssignment
}

export async function declareBlocker(
  supabase: SupabaseClient,
  sessionId: string,
  blockerCardId: string,
  attackerCardId: string,
) {
  const { data, error } = await supabase.rpc('declare_blocker', {
    p_session_id: sessionId,
    p_blocker_card_id: blockerCardId,
    p_attacker_card_id: attackerCardId,
  })

  if (error) {
    throw error
  }

  return data as CombatAssignment
}

export async function setCombatBlockerOrder(
  supabase: SupabaseClient,
  sessionId: string,
  assignmentId: string,
  blockerCardIds: string[],
) {
  const { data, error } = await supabase.rpc('set_combat_blocker_order', {
    p_session_id: sessionId,
    p_assignment_id: assignmentId,
    p_blocker_card_ids: blockerCardIds,
  })

  if (error) {
    throw error
  }

  return data as number
}

export async function adjustCardCounters(
  supabase: SupabaseClient,
  sessionId: string,
  gameCardId: string,
  delta: number,
) {
  const { data, error } = await supabase.rpc('adjust_card_counters', {
    p_session_id: sessionId,
    p_game_card_id: gameCardId,
    p_delta: delta,
  })

  if (error) {
    throw error
  }

  return data as number
}

export async function applyPtPump(
  supabase: SupabaseClient,
  sessionId: string,
  targetCardId: string,
  power: number,
  toughness: number,
) {
  const { error } = await supabase.rpc('create_pt_pump', {
    p_session_id: sessionId,
    p_target_card_id: targetCardId,
    p_power: power,
    p_toughness: toughness,
  })

  if (error) {
    throw error
  }
}

export async function createToken(
  supabase: SupabaseClient,
  sessionId: string,
  playerId: string,
  tokenCardId: string,
  count = 1,
) {
  const { data, error } = await supabase.rpc('create_token', {
    p_session_id: sessionId,
    p_player_id: playerId,
    p_token_card_id: tokenCardId,
    p_count: count,
  })

  if (error) {
    throw error
  }

  return data as number
}

export async function clearCombatAssignments(supabase: SupabaseClient, sessionId: string) {
  const { data, error } = await supabase.rpc('clear_combat_assignments', {
    p_session_id: sessionId,
  })

  if (error) {
    throw error
  }

  return data as number
}

export async function resolveCombatDamage(supabase: SupabaseClient, sessionId: string) {
  const { data, error } = await supabase.rpc('resolve_combat_damage', {
    p_session_id: sessionId,
  })

  if (error) {
    throw error
  }

  return data as CombatDamageResult
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

export async function importDeckFromText(
  supabase: SupabaseClient,
  name: string,
  decklist: string,
) {
  const { data, error } = await supabase.rpc('import_deck_from_text', {
    p_name: name,
    p_decklist: decklist,
  })

  if (error) {
    throw error
  }

  return data as DeckImportResult
}

export async function updateDeckList(
  supabase: SupabaseClient,
  deckId: string,
  cardIds: string[],
) {
  const { data, error } = await supabase.rpc('update_deck_list', {
    p_deck_id: deckId,
    p_card_ids: cardIds,
  })

  if (error) {
    throw error
  }

  return data as { id: string; card_count: number }
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

export async function devAddMana(
  supabase: SupabaseClient,
  sessionId: string,
  playerId: string,
  color: string,
  amount: number,
) {
  const { data, error } = await supabase.rpc('dev_add_mana', {
    p_session_id: sessionId,
    p_player_id: playerId,
    p_color: color,
    p_amount: amount,
  })

  if (error) {
    throw error
  }

  return data as ManaPool
}

export async function devSpawnCard({
  supabase,
  sessionId,
  playerId,
  cardId,
  zone,
  tapped,
}: {
  supabase: SupabaseClient
  sessionId: string
  playerId: string
  cardId: string
  zone: GameZone
  tapped: boolean
}) {
  const { data, error } = await supabase.rpc('dev_spawn_card', {
    p_session_id: sessionId,
    p_player_id: playerId,
    p_card_id: cardId,
    p_zone: zone,
    p_tapped: tapped,
  })

  if (error) {
    throw error
  }

  return data
}

export async function devSetTurnState({
  supabase,
  sessionId,
  phase,
  step,
  activePlayerId,
  priorityPlayerId,
  turnNumber,
}: {
  supabase: SupabaseClient
  sessionId: string
  phase: string
  step: string
  activePlayerId?: string | null
  priorityPlayerId?: string | null
  turnNumber?: number | null
}) {
  const { data, error } = await supabase.rpc('dev_set_turn_state', {
    p_session_id: sessionId,
    p_phase: phase,
    p_step: step,
    p_active_player_id: activePlayerId ?? null,
    p_priority_player_id: priorityPlayerId ?? null,
    p_turn_number: turnNumber ?? null,
  })

  if (error) {
    throw error
  }

  return data as GameTurnState
}

export async function devMoveCardToZone(
  supabase: SupabaseClient,
  sessionId: string,
  gameCardId: string,
  zone: GameZone,
) {
  const { data, error } = await supabase.rpc('dev_move_card_to_zone', {
    p_session_id: sessionId,
    p_game_card_id: gameCardId,
    p_zone: zone,
  })

  if (error) {
    throw error
  }

  return data
}

export async function devSetCardTapped(
  supabase: SupabaseClient,
  sessionId: string,
  gameCardId: string,
  isTapped: boolean,
) {
  const { data, error } = await supabase.rpc('dev_set_card_tapped', {
    p_session_id: sessionId,
    p_game_card_id: gameCardId,
    p_is_tapped: isTapped,
  })

  if (error) {
    throw error
  }

  return data
}

export async function devSetCardDamage(
  supabase: SupabaseClient,
  sessionId: string,
  gameCardId: string,
  damageMarked: number,
) {
  const { data, error } = await supabase.rpc('dev_set_card_damage', {
    p_session_id: sessionId,
    p_game_card_id: gameCardId,
    p_damage_marked: damageMarked,
  })

  if (error) {
    throw error
  }

  return data
}

export async function devShuffleLibrary(
  supabase: SupabaseClient,
  sessionId: string,
  playerId: string,
) {
  const { data, error } = await supabase.rpc('dev_shuffle_library', {
    p_session_id: sessionId,
    p_player_id: playerId,
  })

  if (error) {
    throw error
  }

  return data as number
}

export async function devPutCardOnTop(
  supabase: SupabaseClient,
  sessionId: string,
  gameCardId: string,
) {
  const { data, error } = await supabase.rpc('dev_put_card_on_top', {
    p_session_id: sessionId,
    p_game_card_id: gameCardId,
  })

  if (error) {
    throw error
  }

  return data
}

export async function devPutCardOnBottom(
  supabase: SupabaseClient,
  sessionId: string,
  gameCardId: string,
) {
  const { data, error } = await supabase.rpc('dev_put_card_on_bottom', {
    p_session_id: sessionId,
    p_game_card_id: gameCardId,
  })

  if (error) {
    throw error
  }

  return data
}

export async function devClearSummoningSickness(
  supabase: SupabaseClient,
  sessionId: string,
  gameCardId: string,
) {
  const { data, error } = await supabase.rpc('dev_clear_summoning_sickness', {
    p_session_id: sessionId,
    p_game_card_id: gameCardId,
  })

  if (error) {
    throw error
  }

  return data
}

export async function devUndoAction(
  supabase: SupabaseClient,
  actionId: string,
) {
  const { data, error } = await supabase.rpc('dev_undo_action', {
    p_action_id: actionId,
  })

  if (error) {
    throw error
  }

  return data as GameActionLog
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
