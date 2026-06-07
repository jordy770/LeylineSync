import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CardCatalogEntry,
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
  targetCardId?: string,
) {
  const { data, error } = await supabase.rpc('cast_card_from_hand', {
    p_session_id: sessionId,
    p_game_card_id: cardId,
    p_generic_payment: genericPayment ?? null,
    p_target_card_id: targetCardId ?? null,
  })

  if (error) {
    throw error
  }

  return data
}

// Cast your commander from the command zone (pays its cost + commander tax).
export async function castCommander(
  supabase: SupabaseClient,
  sessionId: string,
  cardId: string,
  genericPayment?: Record<string, number>,
) {
  const { data, error } = await supabase.rpc('cast_commander', {
    p_session_id: sessionId,
    p_game_card_id: cardId,
    p_generic_payment: genericPayment ?? null,
  })

  if (error) {
    throw error
  }

  return data
}

// Attach an Equipment you control onto a creature you control (sorcery-speed equip).
export async function equip(
  supabase: SupabaseClient,
  sessionId: string,
  equipmentCardId: string,
  targetCardId: string,
  genericPayment?: Record<string, number>,
) {
  const { data, error } = await supabase.rpc('equip', {
    p_session_id: sessionId,
    p_equipment_card_id: equipmentCardId,
    p_target_card_id: targetCardId,
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

// Judge tool: pass priority on behalf of all players (resolve the stack or advance the step).
export async function devPassPriority(supabase: SupabaseClient, sessionId: string) {
  const { data, error } = await supabase.rpc('dev_pass_priority', {
    p_session_id: sessionId,
  })

  if (error) {
    throw error
  }

  return data as GameTurnState
}

export async function setCardScript(
  supabase: SupabaseClient,
  cardId: string,
  script: CardScript | null,
) {
  const { data, error } = await supabase.rpc('set_card_script', {
    p_card_id: cardId,
    p_script: script,
  })

  if (error) {
    throw error
  }

  return data as CardCatalogEntry
}

export async function relinkCardScripts(supabase: SupabaseClient) {
  const { data, error } = await supabase.rpc('relink_card_scripts')

  if (error) {
    throw error
  }

  return (data ?? 0) as number
}

export async function putDealDamagePlayerOnStack(
  supabase: SupabaseClient,
  sessionId: string,
  targetPlayerId: string,
  amount: number,
  timing: 'instant' | 'sorcery',
  sourceCardId?: string | null,
  genericPayment?: Record<string, number>,
  xValue?: number | null,
) {
  const { data, error } = await supabase.rpc('put_action_on_stack', {
    p_session_id: sessionId,
    p_action_type: 'deal_damage_player',
    p_payload: {
      target_player_id: targetPlayerId,
      // X spell: send the literal "X" + the chosen x_value; the server resolves
      // the amount from x_value (after charging {X} mana) so it can't be forged.
      amount: xValue != null ? 'X' : amount,
      x_value: xValue ?? null,
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

export type TargetController = 'any' | 'opponent' | 'you'

export async function putDealDamageCreatureOnStack(
  supabase: SupabaseClient,
  sessionId: string,
  targetCardId: string,
  amount: number,
  timing: 'instant' | 'sorcery',
  sourceCardId?: string | null,
  genericPayment?: Record<string, number>,
  targetController?: TargetController | null,
  xValue?: number | null,
) {
  const { data, error } = await supabase.rpc('put_action_on_stack', {
    p_session_id: sessionId,
    p_action_type: 'deal_damage_creature',
    p_payload: {
      target_card_id: targetCardId,
      amount: xValue != null ? 'X' : amount,
      x_value: xValue ?? null,
      timing,
      target_controller: targetController ?? null,
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
  targetController?: TargetController | null,
) {
  const { data, error } = await supabase.rpc('put_action_on_stack', {
    p_session_id: sessionId,
    p_action_type: 'pump_creature',
    p_payload: {
      target_card_id: targetCardId,
      power,
      toughness,
      timing,
      target_controller: targetController ?? null,
      generic_payment: genericPayment ?? null,
    },
    p_source_card_id: sourceCardId ?? null,
  })

  if (error) {
    throw error
  }

  return data as StackItem
}

export async function putSetPtCreatureOnStack(
  supabase: SupabaseClient,
  sessionId: string,
  targetCardId: string,
  power: number,
  toughness: number,
  timing: 'instant' | 'sorcery',
  sourceCardId?: string | null,
  genericPayment?: Record<string, number>,
  targetController?: TargetController | null,
) {
  const { data, error } = await supabase.rpc('put_action_on_stack', {
    p_session_id: sessionId,
    p_action_type: 'set_pt_creature',
    p_payload: {
      target_card_id: targetCardId,
      power,
      toughness,
      timing,
      target_controller: targetController ?? null,
      generic_payment: genericPayment ?? null,
    },
    p_source_card_id: sourceCardId ?? null,
  })

  if (error) {
    throw error
  }

  return data as StackItem
}

export type TargetedCreatureActionType =
  | 'destroy_creature'
  | 'bounce_creature'
  | 'tap_creature'
  | 'untap_creature'
  | 'add_counters_creature'
  | 'exile_creature'
  | 'grant_keyword_creature'
  | 'gain_control_creature'

export async function putTargetedCreatureActionOnStack(
  supabase: SupabaseClient,
  sessionId: string,
  actionType: TargetedCreatureActionType,
  targetCardId: string,
  timing: 'instant' | 'sorcery',
  sourceCardId?: string | null,
  genericPayment?: Record<string, number>,
  targetController?: TargetController | null,
) {
  const { data, error } = await supabase.rpc('put_action_on_stack', {
    p_session_id: sessionId,
    p_action_type: actionType,
    p_payload: {
      target_card_id: targetCardId,
      timing,
      target_controller: targetController ?? null,
      generic_payment: genericPayment ?? null,
    },
    p_source_card_id: sourceCardId ?? null,
  })

  if (error) {
    throw error
  }

  return data as StackItem
}

// Multi-target removal: apply one kind (destroy/exile/bounce/tap/untap) to up to N
// chosen creatures. Targets are locked at cast; the server validates each is legal.
export type MultiCreatureKind = 'destroy' | 'exile' | 'bounce' | 'tap' | 'untap'

export async function castMultiCreatureEffect(
  supabase: SupabaseClient,
  sessionId: string,
  kind: MultiCreatureKind,
  targetCardIds: string[],
  timing: 'instant' | 'sorcery',
  sourceCardId?: string | null,
  genericPayment?: Record<string, number>,
  targetController?: TargetController | null,
) {
  const { data, error } = await supabase.rpc('put_action_on_stack', {
    p_session_id: sessionId,
    p_action_type: 'multi_creature_effect',
    p_payload: {
      kind,
      target_card_ids: targetCardIds,
      timing,
      target_controller: targetController ?? null,
      generic_payment: genericPayment ?? null,
    },
    p_source_card_id: sourceCardId ?? null,
  })

  if (error) {
    throw error
  }

  return data as StackItem
}

// Modal spell ("choose one —"): cast a card's modes; the engine creates a
// choose_mode decision the caster resolves (mode selection + any creature target).
export type ModalMode = { label?: string; actions: unknown[] }

export async function castModalSpell(
  supabase: SupabaseClient,
  sessionId: string,
  modes: ModalMode[],
  choose: number,
  sourceCardId?: string | null,
) {
  const { data, error } = await supabase.rpc('cast_modal_spell', {
    p_session_id: sessionId,
    p_modes: modes,
    p_choose: choose,
    p_source_card_id: sourceCardId ?? null,
  })

  if (error) {
    throw error
  }

  return data as StackItem
}

// Divided damage — deal `amount` split across targets as the caster allocates
// (Forked Bolt). Each allocation targets a creature OR a player; amounts sum to total.
export type DamageAllocation =
  | { target_card_id: string; amount: number }
  | { target_player_id: string; amount: number }

export async function castDividedDamage(
  supabase: SupabaseClient,
  sessionId: string,
  amount: number,
  allocations: DamageAllocation[],
  timing: 'instant' | 'sorcery',
  sourceCardId?: string | null,
  genericPayment?: Record<string, number>,
  targetController?: TargetController | null,
) {
  const { data, error } = await supabase.rpc('put_action_on_stack', {
    p_session_id: sessionId,
    p_action_type: 'divided_damage',
    p_payload: {
      amount,
      allocations,
      timing,
      target_controller: targetController ?? null,
      generic_payment: genericPayment ?? null,
    },
    p_source_card_id: sourceCardId ?? null,
  })

  if (error) {
    throw error
  }

  return data as StackItem
}

// Single-target removal of a non-creature (or any) permanent — destroy/exile/
// bounce/tap/untap a target artifact/enchantment/land/planeswalker/permanent.
export async function castPermanentEffect(
  supabase: SupabaseClient,
  sessionId: string,
  kind: MultiCreatureKind,
  targetCardId: string,
  targetType: string | string[],
  timing: 'instant' | 'sorcery',
  sourceCardId?: string | null,
  genericPayment?: Record<string, number>,
  targetController?: TargetController | null,
  then?: unknown[],
  controllerSearchesBasicLand?: boolean,
) {
  const { data, error } = await supabase.rpc('put_action_on_stack', {
    p_session_id: sessionId,
    p_action_type: 'permanent_effect',
    p_payload: {
      kind,
      target_card_id: targetCardId,
      target_type: targetType,
      timing,
      target_controller: targetController ?? null,
      generic_payment: genericPayment ?? null,
      then: then ?? [],
      controller_searches_basic_land: controllerSearchesBasicLand ?? false,
    },
    p_source_card_id: sourceCardId ?? null,
  })

  if (error) {
    throw error
  }

  return data as StackItem
}

export async function putAddCountersCreatureOnStack(
  supabase: SupabaseClient,
  sessionId: string,
  targetCardId: string,
  amount: number,
  timing: 'instant' | 'sorcery',
  sourceCardId?: string | null,
  genericPayment?: Record<string, number>,
  targetController?: TargetController | null,
  xValue?: number | null,
) {
  const { data, error } = await supabase.rpc('put_action_on_stack', {
    p_session_id: sessionId,
    p_action_type: 'add_counters_creature',
    p_payload: {
      target_card_id: targetCardId,
      amount: xValue != null ? 'X' : amount,
      x_value: xValue ?? null,
      timing,
      target_controller: targetController ?? null,
      generic_payment: genericPayment ?? null,
    },
    p_source_card_id: sourceCardId ?? null,
  })

  if (error) {
    throw error
  }

  return data as StackItem
}

// Combat-trick / instant: "target creature gains <keyword> until end of turn".
// The keyword is fixed by the card's script; the payload carries it to
// apply_creature_effect's grant_keyword branch (which inserts the until-EOT row).
export async function putGrantKeywordCreatureOnStack(
  supabase: SupabaseClient,
  sessionId: string,
  targetCardId: string,
  keyword: string,
  timing: 'instant' | 'sorcery',
  sourceCardId?: string | null,
  genericPayment?: Record<string, number>,
  targetController?: TargetController | null,
) {
  const { data, error } = await supabase.rpc('put_action_on_stack', {
    p_session_id: sessionId,
    p_action_type: 'grant_keyword_creature',
    p_payload: {
      target_card_id: targetCardId,
      keyword,
      timing,
      target_controller: targetController ?? null,
      generic_payment: genericPayment ?? null,
    },
    p_source_card_id: sourceCardId ?? null,
  })

  if (error) {
    throw error
  }

  return data as StackItem
}

// Gain control of a target creature (Threaten / Act of Treason / Mind Control).
// duration ('permanent'|'end_of_turn') and the threaten extras (untap, haste) are
// fixed by the card's script; the resolve handler injects the acting controller.
export async function putGainControlCreatureOnStack(
  supabase: SupabaseClient,
  sessionId: string,
  targetCardId: string,
  duration: string,
  untap: boolean,
  haste: boolean,
  timing: 'instant' | 'sorcery',
  sourceCardId?: string | null,
  genericPayment?: Record<string, number>,
  targetController?: TargetController | null,
) {
  const { data, error } = await supabase.rpc('put_action_on_stack', {
    p_session_id: sessionId,
    p_action_type: 'gain_control_creature',
    p_payload: {
      target_card_id: targetCardId,
      duration,
      untap,
      haste,
      timing,
      target_controller: targetController ?? null,
      generic_payment: genericPayment ?? null,
    },
    p_source_card_id: sourceCardId ?? null,
  })

  if (error) {
    throw error
  }

  return data as StackItem
}

// Fight (Prey Upon / Pit Fight): a creature you control fights another creature.
// fighterCardId is yours; foughtCardId is the target. foughtController restricts
// the fought creature server-side (e.g. 'opponent' for "you don't control").
export async function castFight(
  supabase: SupabaseClient,
  sessionId: string,
  fighterCardId: string,
  foughtCardId: string,
  sourceCardId?: string | null,
  foughtController?: TargetController | null,
  genericPayment?: Record<string, number>,
) {
  const { data, error } = await supabase.rpc('cast_fight', {
    p_session_id: sessionId,
    p_fighter_card_id: fighterCardId,
    p_fought_card_id: foughtCardId,
    p_source_card_id: sourceCardId ?? null,
    p_fought_controller: foughtController ?? 'any',
    p_generic_payment: genericPayment ?? null,
  })

  if (error) {
    throw error
  }

  return data as StackItem
}

export async function chooseTriggeredAbilityCreatureTarget(
  supabase: SupabaseClient,
  sessionId: string,
  stackItemId: string,
  targetCardId: string,
) {
  const { data, error } = await supabase.rpc('choose_triggered_ability_creature_target', {
    p_session_id: sessionId,
    p_stack_item_id: stackItemId,
    p_target_card_id: targetCardId,
  })

  if (error) {
    throw error
  }

  return data as StackItem
}

// Multi-target trigger: choose up to N targets for a triggered ability at once.
export async function chooseTriggeredAbilityTargets(
  supabase: SupabaseClient,
  sessionId: string,
  stackItemId: string,
  targetCardIds: string[],
) {
  const { data, error } = await supabase.rpc('choose_triggered_ability_targets', {
    p_session_id: sessionId,
    p_stack_item_id: stackItemId,
    p_target_card_ids: targetCardIds,
  })

  if (error) {
    throw error
  }

  return data as StackItem
}

export async function putDrawCardsOnStack(
  supabase: SupabaseClient,
  sessionId: string,
  amount: number,
  timing: 'instant' | 'sorcery',
  sourceCardId?: string | null,
  genericPayment?: Record<string, number>,
  xValue?: number | null,
) {
  const { data, error } = await supabase.rpc('put_action_on_stack', {
    p_session_id: sessionId,
    p_action_type: 'draw_cards',
    p_payload: {
      amount: xValue != null ? 'X' : amount,
      x_value: xValue ?? null,
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

// Untargeted scry spell (Tier-B resolution-time decision). Announces the scry;
// it parks on resolution awaiting the caster's reorder (submit_decision).
export async function castScrySpell(
  supabase: SupabaseClient,
  sessionId: string,
  amount: number,
  sourceCardId?: string | null,
) {
  const { data, error } = await supabase.rpc('cast_scry', {
    p_session_id: sessionId,
    p_amount: amount,
    p_source_card_id: sourceCardId ?? null,
  })

  if (error) {
    throw error
  }

  return data as StackItem
}

// Untargeted surveil spell (Tier-B). Parks on resolution awaiting the caster's
// graveyard/top split (submit_decision).
export async function castSurveilSpell(
  supabase: SupabaseClient,
  sessionId: string,
  amount: number,
  sourceCardId?: string | null,
) {
  const { data, error } = await supabase.rpc('cast_surveil', {
    p_session_id: sessionId,
    p_amount: amount,
    p_source_card_id: sourceCardId ?? null,
  })

  if (error) {
    throw error
  }

  return data as StackItem
}

// Cast a non-permanent spell whose resolution is an untargeted effect program
// (e.g. Opt: scry 1, then draw a card). Runs each action in order, parking on a
// scry/surveil, and moves the source instant/sorcery to the graveyard on cast.
export async function castSpellEffect(
  supabase: SupabaseClient,
  sessionId: string,
  actions: unknown[],
  sourceCardId?: string | null,
  xValue?: number | null,
) {
  const { data, error } = await supabase.rpc('cast_spell_effect', {
    p_session_id: sessionId,
    p_actions: actions,
    p_source_card_id: sourceCardId ?? null,
    p_x_value: xValue ?? null,
  })

  if (error) {
    throw error
  }

  return data as StackItem
}

// Submit a pending decision's result (choose_mode / scry / surveil).
export async function submitDecision(
  supabase: SupabaseClient,
  decisionId: string,
  result: Record<string, unknown>,
) {
  const { data, error } = await supabase.rpc('submit_decision', {
    p_decision_id: decisionId,
    p_result: result,
  })

  if (error) {
    throw error
  }

  return data
}

export async function activateAbility(
  supabase: SupabaseClient,
  sessionId: string,
  sourceCardId: string,
  abilityIndex: number,
  target?: { targetCardId?: string | null; targetPlayerId?: string | null },
  genericPayment?: Record<string, number>,
) {
  const { data, error } = await supabase.rpc('activate_ability', {
    p_session_id: sessionId,
    p_source_card_id: sourceCardId,
    p_ability_index: abilityIndex,
    p_target_player_id: target?.targetPlayerId ?? null,
    p_target_card_id: target?.targetCardId ?? null,
    p_generic_payment: genericPayment ?? null,
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

export async function createGameSession(
  supabase: SupabaseClient,
  format: 'standard' | 'commander' = 'standard',
) {
  const { data, error } = await supabase.rpc('create_game_session', { p_format: format })

  if (error) {
    throw error
  }

  return data as string
}

// Flip a session to the Commander format (40 life). Call right after creating it.
export async function setCommanderFormat(supabase: SupabaseClient, sessionId: string) {
  const { error } = await supabase.rpc('set_commander_format', {
    p_session_id: sessionId,
  })

  if (error) {
    throw error
  }
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

/**
 * Player-chosen combat damage over-assignment. `assignments` maps an attacker
 * game_card id to its distribution: per-blocker amounts and an optional trample
 * amount to the defending player. Omit it for the engine's auto minimum-lethal
 * distribution (the server validates lethal-before-later-blocker ordering).
 */
export type CombatDamageAssignments = Record<
  string,
  { blockers?: { blocker_card_id: string; amount: number }[]; trample?: number }
>

export async function resolveCombatDamage(
  supabase: SupabaseClient,
  sessionId: string,
  assignments?: CombatDamageAssignments,
) {
  const { data, error } = await supabase.rpc('resolve_combat_damage', {
    p_session_id: sessionId,
    p_assignments: assignments ?? null,
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
  // Seeds the library and — in a Commander game — the commander into the command
  // zone. The previous Deno edge function (spawn-deck) is superseded by this RPC.
  const { data, error } = await supabase.rpc('spawn_deck_for_session', {
    p_session_id: sessionId,
    p_deck_id: deckId,
  })

  if (error) {
    throw error
  }

  return data as { library: number; commander_seeded: boolean }
}

// Designate (or clear, with null) a deck's commander.
export async function setDeckCommander(
  supabase: SupabaseClient,
  deckId: string,
  cardId: string | null,
) {
  const { error } = await supabase.rpc('set_deck_commander', {
    p_deck_id: deckId,
    p_card_id: cardId,
  })

  if (error) {
    throw error
  }
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
  commanderIdentity,
}: {
  supabase: SupabaseClient
  cardId: string
  sessionId: string
  playerId: string
  color: string
  amount: number
  shouldTapCard: boolean
  // True for a `color:'commander'` source — the engine then validates the chosen
  // colour is in the player's commander's colour identity.
  commanderIdentity?: boolean
}) {
  const { data, error } = await supabase.rpc('add_mana_from_card', {
    p_game_card_id: cardId,
    p_session_id: sessionId,
    p_player_id: playerId,
    p_color: color,
    p_amount: amount,
    p_should_tap_card: shouldTapCard,
    p_commander_identity: commanderIdentity ?? false,
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
