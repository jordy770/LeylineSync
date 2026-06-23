import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  BoardCard,
  CombatActionState,
  CombatAssignment,
  CardCatalogFilters,
  ControllerCard,
  DeckDetail,
  DeckSummary,
  GameCardInstanceRow,
  GameSession,
  GameSessionPlayer,
  GameSessionStatus,
  GameActionLog,
  GameTurnState,
  GameZone,
  LinkedCard,
  ManaPool,
  PendingDecision,
  RestrictedManaEntry,
  TokenCard,
  StackItem,
  TurnPhase,
  TurnStep,
} from './types'

export const emptyManaPool: ManaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }
export const gameZones = ['library', 'hand', 'stack', 'battlefield', 'graveyard', 'exile', 'command'] as const
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
      zone,
      controller_player_id,
      plus_one_counters,
      counters,
      attached_to,
      is_token,
      copy_original_card_id
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
    'id, name, image_url, type_line, mana_cost, power_toughness',
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
      type_line: linkedCard?.type_line ?? null,
      mana_cost: linkedCard?.mana_cost ?? null,
      power_toughness: linkedCard?.power_toughness ?? null,
      controller_player_id: item.controller_player_id ?? null,
      plus_one_counters: (item as { plus_one_counters?: number }).plus_one_counters ?? 0,
      counters: (item as { counters?: Record<string, number> | null }).counters ?? null,
      attached_to: (item as { attached_to?: string | null }).attached_to ?? null,
      is_token: (item as { is_token?: boolean | null }).is_token ?? false,
      copy_original_card_id: (item as { copy_original_card_id?: string | null }).copy_original_card_id ?? null,
    }
  })
}

// Per-card protection colours (effect_type 'protection', payload.from), keyed by the
// affected game_card id. Lets the controller pre-filter targets/blocks a creature's
// protection forbids (the server is authoritative either way).
// Board-status effects the UI badges (mig 287): which cards are ANIMATED
// lands (mig 277) and which players are protected by ATTACK TAXES (mig 275).
export async function getStatusEffects(supabase: SupabaseClient, sessionId: string) {
  const animatedIds = new Set<string>()
  const taxes: { playerId: string; mana: number; life: number }[] = []
  const { data, error } = await supabase
    .from('game_continuous_effects')
    .select('effect_type, affected_card_id, affected_player_id, payload')
    .eq('session_id', sessionId)
    .in('effect_type', ['animated', 'attack_tax'])
  if (error) {
    console.error('Failed to load status effects:', error.message)
    return { animatedIds, taxes }
  }
  for (const row of (data ?? []) as { effect_type: string; affected_card_id: string | null; affected_player_id: string | null; payload: Record<string, unknown> | null }[]) {
    if (row.effect_type === 'animated' && row.affected_card_id) animatedIds.add(row.affected_card_id)
    if (row.effect_type === 'attack_tax' && row.affected_player_id) {
      taxes.push({ playerId: row.affected_player_id, mana: Number(row.payload?.mana ?? 0), life: Number(row.payload?.life ?? 0) })
    }
  }
  return { animatedIds, taxes }
}

// Active generic-mana cost reductions the player controls (effect_type
// 'cost_reduction'), mirroring the server's reduced_mana_cost STATIC source so
// the controller's "playable" hint + auto-pay account for "Dragon spells cost
// {1} less" etc. The card's OWN cost_reduction script prop is applied separately.
export type CostReductionEffect = { amount: number; type_line: string | null; from_zone: string | null }

export async function getCostReductions(
  supabase: SupabaseClient,
  sessionId: string,
  playerId: string,
): Promise<CostReductionEffect[]> {
  const { data, error } = await supabase
    .from('game_continuous_effects')
    .select('payload, affected_player_id')
    .eq('session_id', sessionId)
    .eq('effect_type', 'cost_reduction')
    .eq('affected_player_id', playerId)

  if (error) {
    console.error('Failed to load cost reductions:', error.message)
    return []
  }

  return (data ?? []).map((row) => {
    const p = (row as { payload: Record<string, unknown> | null }).payload ?? {}
    return {
      amount: Number(p.amount ?? 0),
      type_line: typeof p.type_line === 'string' && p.type_line !== '' ? (p.type_line as string) : null,
      from_zone: typeof p.from_zone === 'string' && p.from_zone !== '' ? (p.from_zone as string) : null,
    }
  })
}

export async function getProtectionColors(supabase: SupabaseClient, sessionId: string) {
  const colorsByCard: Record<string, string[]> = {}

  const { data, error } = await supabase
    .from('game_continuous_effects')
    .select('affected_card_id, payload')
    .eq('session_id', sessionId)
    .eq('effect_type', 'protection')

  if (error) {
    console.error('Failed to load protection effects:', error.message)
    return colorsByCard
  }

  for (const row of (data ?? []) as { affected_card_id: string | null; payload: Record<string, unknown> | null }[]) {
    const id = row.affected_card_id
    const from = typeof row.payload?.from === 'string' ? (row.payload.from as string).toLowerCase() : null
    if (!id || !from) continue
    const list = colorsByCard[id] ?? []
    if (!list.includes(from)) list.push(from)
    colorsByCard[id] = list
  }

  return colorsByCard
}

export type OpponentZoneData = {
  graveyard: BoardCard[]
  exile: BoardCard[]
  handCount: number
  libraryCount: number
}

export async function getOpponentZoneData(
  supabase: SupabaseClient,
  sessionId: string,
  playerId: string,
): Promise<OpponentZoneData> {
  const [graveyardResult, exileResult, handCountResult, libraryCountResult] = await Promise.all([
    supabase
      .from('game_cards')
      .select('id, card_id, is_tapped, damage_marked, zone, controller_player_id, is_face_down')
      .eq('session_id', sessionId)
      .eq('controller_player_id', playerId)
      .eq('zone', 'graveyard'),
    supabase
      .from('game_cards')
      .select('id, card_id, is_tapped, damage_marked, zone, controller_player_id, is_face_down')
      .eq('session_id', sessionId)
      .eq('controller_player_id', playerId)
      .eq('zone', 'exile'),
    supabase
      .from('game_cards')
      .select('*', { count: 'exact', head: true })
      .eq('session_id', sessionId)
      .eq('controller_player_id', playerId)
      .eq('zone', 'hand'),
    supabase
      .from('game_cards')
      .select('*', { count: 'exact', head: true })
      .eq('session_id', sessionId)
      .eq('controller_player_id', playerId)
      .eq('zone', 'library'),
  ])

  const graveyardRows = (graveyardResult.data ?? []) as GameCardInstanceRow[]
  const exileRows = (exileResult.data ?? []) as GameCardInstanceRow[]
  const allCardIds = [...graveyardRows, ...exileRows].map((r) => r.card_id)

  const linkedCards = allCardIds.length > 0
    ? await getLinkedCardsById(supabase, allCardIds, 'id, name, image_url, type_line')
    : new Map<string, LinkedCard>()

  const toZoneCard = (item: GameCardInstanceRow): BoardCard => {
    const linked = linkedCards.get(item.card_id) ?? null
    const faceDown = (item as Record<string, unknown>).is_face_down === true
    return {
      id: item.id,
      card_id: item.card_id,
      position_x: 0,
      position_y: 0,
      is_tapped: item.is_tapped,
      damage_marked: item.damage_marked ?? 0,
      zone: normalizeGameZone(item.zone),
      name: faceDown ? 'Hidden card' : (linked?.name ?? 'Unknown'),
      image_url: faceDown ? null : (linked?.image_url ?? null),
      type_line: faceDown ? null : (linked?.type_line ?? null),
      controller_player_id: item.controller_player_id ?? null,
      is_face_down: faceDown,
    }
  }

  return {
    graveyard: graveyardRows.map(toZoneCard),
    exile: exileRows.map(toZoneCard),
    handCount: handCountResult.count ?? 0,
    libraryCount: libraryCountResult.count ?? 0,
  }
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
      entered_battlefield_turn_number,
      plus_one_counters,
      counters,
      is_commander,
      command_zone_casts,
      attached_to,
      is_token,
      copy_original_card_id
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
      'id, name, image_url, script, type_line, mana_cost, oracle_text, keywords, power, toughness, power_toughness, is_token',
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
      plus_one_counters: card.plus_one_counters ?? 0,
      counters: (card as { counters?: Record<string, number> | null }).counters ?? null,
      is_commander: (card as { is_commander?: boolean }).is_commander ?? false,
      command_zone_casts: (card as { command_zone_casts?: number }).command_zone_casts ?? 0,
      attached_to: (card as { attached_to?: string | null }).attached_to ?? null,
      is_token: (card as { is_token?: boolean | null }).is_token ?? false,
      copy_original_card_id: (card as { copy_original_card_id?: string | null }).copy_original_card_id ?? null,
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

// "Spend only to …" mana held apart from the open pool (Haven of the Spirit
// Dragon, Drover of the Mighty, …). Returns the raw entries for display.
export async function getPlayerRestrictedMana(
  supabase: SupabaseClient,
  sessionId: string,
  playerId: string,
): Promise<RestrictedManaEntry[]> {
  const { data, error } = await supabase
    .from('game_players')
    .select('restricted_mana')
    .eq('session_id', sessionId)
    .eq('player_id', playerId)
    .maybeSingle()

  if (error) {
    throw error
  }

  const raw = (data?.restricted_mana as RestrictedManaEntry[] | null) ?? []
  return Array.isArray(raw) ? raw.filter((e) => e && (e.amount ?? 0) > 0) : []
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
    .select('id, status, format, created_by, created_at, locked_at, finished_at, winner_player_id')
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

// Player ids that have a spawned library in this session — the lobby treats this
// as "ready" (start_game_session requires every player to have a library). Reads
// game_cards directly; session members may read fellow members' rows (mig 143).
export async function getSpawnedDeckOwnerIds(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('game_cards')
    .select('owner_id')
    .eq('session_id', sessionId)
    .eq('zone', 'library')

  if (error) {
    throw error
  }

  return new Set((data ?? []).map((row) => (row as { owner_id: string }).owner_id))
}

export type CommanderDamageEntry = { sourceCardId: string; name: string; damage: number }

// Cumulative commander combat damage each player has taken, keyed by defender
// player id (Commander: 21 from a single commander is lethal). Resolves the
// source game-card to its catalog name. Empty in non-Commander games.
export async function getCommanderDamage(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<Record<string, CommanderDamageEntry[]>> {
  const { data, error } = await supabase
    .from('game_commander_damage')
    .select('defender_player_id, source_card_id, damage')
    .eq('session_id', sessionId)
    .gt('damage', 0)

  if (error) {
    console.error('Failed to load commander damage:', error.message)
    return {}
  }

  const rows = (data ?? []) as { defender_player_id: string; source_card_id: string; damage: number }[]
  if (rows.length === 0) return {}

  // source_card_id is a game_cards.id → resolve to its catalog name.
  const sourceIds = [...new Set(rows.map((r) => r.source_card_id))]
  const { data: gcData } = await supabase
    .from('game_cards')
    .select('id, card_id')
    .in('id', sourceIds)
  const cardIdByGameCard = new Map((gcData ?? []).map((r) => [r.id as string, r.card_id as string]))
  const names = await getLinkedCardsById(supabase, [...cardIdByGameCard.values()], 'id, name')

  const byDefender: Record<string, CommanderDamageEntry[]> = {}
  for (const r of rows) {
    const cardId = cardIdByGameCard.get(r.source_card_id)
    const name = (cardId ? names.get(cardId)?.name : null) ?? 'Commander'
    ;(byDefender[r.defender_player_id] ??= []).push({
      sourceCardId: r.source_card_id,
      name,
      damage: r.damage,
    })
  }
  return byDefender
}

export async function getGameActionLogs(
  supabase: SupabaseClient,
  sessionId: string,
  limit = 12,
) {
  const { data, error } = await supabase
    .from('game_action_log')
    .select('id, session_id, actor_player_id, target_player_id, action_type, description, before_state, after_state, created_at, undone_at, undone_by')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    throw error
  }

  return (data ?? []) as GameActionLog[]
}

/**
 * Game-card ids the player may currently cast from EXILE (mig 230 impulse,
 * mig 295 adventure faces, …). Reads the player's `play_from_exile` permissions
 * and flattens their payload.card_ids. The cast path (cast_card_from_hand /
 * cast_spell_effect / put_action_on_stack) re-validates the permission server-side.
 * Best-effort: returns an empty set on error.
 */
export async function getPlayableFromExileIds(
  supabase: SupabaseClient,
  sessionId: string,
  playerId: string,
): Promise<Set<string>> {
  const ids = new Set<string>()
  const { data, error } = await supabase
    .from('game_continuous_effects')
    .select('payload')
    .eq('session_id', sessionId)
    .eq('effect_type', 'play_from_exile')
    .eq('affected_player_id', playerId)

  if (error) {
    console.error('Failed to load play-from-exile permissions:', error.message)
    return ids
  }

  for (const row of (data ?? []) as { payload: Record<string, unknown> | null }[]) {
    const cardIds = row.payload?.card_ids
    if (Array.isArray(cardIds)) {
      for (const id of cardIds) {
        if (typeof id === 'string') ids.add(id)
      }
    }
  }

  return ids
}

/** Sums active until-end-of-turn pump effects per affected card id. Best-effort: returns {} on error. */
export async function getActivePumpTotals(supabase: SupabaseClient, sessionId: string) {
  const totals: Record<string, { power: number; toughness: number }> = {}

  const { data, error } = await supabase
    .from('game_continuous_effects')
    .select('affected_card_id, payload')
    .eq('session_id', sessionId)
    .eq('effect_type', 'pump')

  if (error) {
    console.error('Failed to load pump effects:', error.message)
    return totals
  }

  for (const row of (data ?? []) as { affected_card_id: string | null; payload: Record<string, unknown> | null }[]) {
    const id = row.affected_card_id
    if (!id) continue
    const power = Number(row.payload?.power ?? 0)
    const toughness = Number(row.payload?.toughness ?? 0)
    const entry = totals[id] ?? { power: 0, toughness: 0 }
    entry.power += Number.isFinite(power) ? power : 0
    entry.toughness += Number.isFinite(toughness) ? toughness : 0
    totals[id] = entry
  }

  return totals
}

export async function getTokenCards(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('cards')
    .select('id, name, type_line, power_toughness')
    .eq('is_token', true)
    .order('name')

  if (error) {
    throw error
  }

  return (data ?? []) as TokenCard[]
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

export async function getPendingDecisions(supabase: SupabaseClient, sessionId: string) {
  const { data, error } = await supabase.rpc('get_pending_decisions', {
    p_session_id: sessionId,
  })

  if (error) {
    throw error
  }

  return (data ?? []) as PendingDecision[]
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

export async function getUserDecks(supabase: SupabaseClient) {
  const playerId = await getCurrentPlayerId(supabase)

  if (!playerId) {
    return []
  }

  const { data, error } = await supabase
    .from('decks')
    .select('id, name, list_data, created_at')
    .or(`created_by.eq.${playerId},owner_id.eq.${playerId}`)
    .order('created_at', { ascending: false })

  if (error) {
    throw error
  }

  return (data ?? []).map((deck) => ({
    id: deck.id,
    name: deck.name ?? null,
    card_count: Array.isArray(deck.list_data) ? deck.list_data.length : 0,
    created_at: deck.created_at ?? null,
  })) as DeckSummary[]
}

// Shared precon decks — curated decklists every player can spawn (not owned by
// anyone). Visible via the "Anyone can read precon decks" RLS policy.
export async function getPreconDecks(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('decks')
    .select('id, name, list_data, created_at')
    .eq('is_precon', true)
    .order('name', { ascending: true })

  if (error) {
    throw error
  }

  return (data ?? []).map((deck) => ({
    id: deck.id,
    name: deck.name ?? null,
    card_count: Array.isArray(deck.list_data) ? deck.list_data.length : 0,
    created_at: deck.created_at ?? null,
  })) as DeckSummary[]
}

export async function getDeckDetail(supabase: SupabaseClient, deckId: string) {
  const { data, error } = await supabase
    .from('decks')
    .select('id, name, list_data, created_at, commander_card_id')
    .eq('id', deckId)
    .maybeSingle()

  if (error) {
    throw error
  }

  if (!data) {
    return null
  }

  const cardIds = Array.isArray(data.list_data) ? (data.list_data as string[]) : []
  const linkedCardsById = await getLinkedCardsById(
    supabase,
    cardIds,
    'id, name, image_url, type_line, mana_cost, oracle_text, keywords, power, toughness, power_toughness, script',
  )
  const countsByCardId = new Map<string, number>()

  for (const cardId of cardIds) {
    countsByCardId.set(cardId, (countsByCardId.get(cardId) ?? 0) + 1)
  }

  return {
    id: data.id,
    name: data.name ?? null,
    card_count: cardIds.length,
    created_at: data.created_at ?? null,
    commander_card_id: (data as { commander_card_id?: string | null }).commander_card_id ?? null,
    cards: [...countsByCardId.entries()]
      .map(([cardId, quantity]) => ({
        card_id: cardId,
        quantity,
        card: linkedCardsById.get(cardId) ?? null,
      }))
      .sort((left, right) =>
        (left.card?.name ?? left.card_id).localeCompare(right.card?.name ?? right.card_id),
      ),
  } as DeckDetail
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

// Full catalog detail for a single card, including its behavior script and
// oracle_id. Used by the card-behavior authoring editor.
export async function getCardDetail(supabase: SupabaseClient, cardId: string) {
  const { data, error } = await supabase
    .from('cards')
    .select(
      'id, oracle_id, name, image_url, type_line, mana_cost, oracle_text, keywords, power, toughness, power_toughness, script',
    )
    .eq('id', cardId)
    .maybeSingle()

  if (error) {
    throw error
  }

  return (data ?? null) as LinkedCard | null
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
    format: session.format ?? null,
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
