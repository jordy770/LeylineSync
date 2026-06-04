// High-level test-chamber API. A Scenario owns a transaction-scoped game with
// two players and exposes ergonomic verbs so tests read like the manual test
// plan (docs/test-plan-079-086.md):
//
//   const s = await Scenario.create(client)
//   const bear = await s.spawnCreature('B', 'Air Elemental Test')
//   await s.as('A').putOnStack('destroy_creature', { target_card_id: bear })
//   await s.resolveStack()
//   expect(await s.zoneOf(bear)).toBe('graveyard')
//
// All state lives inside the caller's rolled-back transaction (see db.ts), so
// scenarios never persist and never need cleanup.

import { randomUUID } from 'node:crypto'
import type { Client } from 'pg'
import { asPlayer, rpc } from './db'

export type Seat = 'A' | 'B'
export type Zone = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'stack'

export class Scenario {
  private constructor(
    readonly client: Client,
    readonly sessionId: string,
    readonly players: Record<Seat, string>,
    private acting: Seat = 'A',
  ) {}

  /** Create a 2-player session. Seat A is the creator + active player. */
  static async create(client: Client): Promise<Scenario> {
    const players: Record<Seat, string> = { A: randomUUID(), B: randomUUID() }

    // Note: the auth/profiles FKs are dropped locally by migration
    // 00000000000001_local_test_relax_fks.sql, so throwaway player UUIDs need no
    // auth.users / profiles rows.
    const sessionId = await asPlayer(client, players.A, () =>
      rpc<string>(client, 'create_game_session'),
    )
    await asPlayer(client, players.B, () =>
      rpc(client, 'join_game_session', { p_session_id: sessionId }),
    )

    return new Scenario(client, sessionId, players)
  }

  /** Set the seat whose priority/identity subsequent actions run as. */
  as(seat: Seat): this {
    this.acting = seat
    return this
  }

  private run<T>(fn: () => Promise<T>, seat: Seat = this.acting): Promise<T> {
    return asPlayer(this.client, this.players[seat], fn)
  }

  // --- Setup ---------------------------------------------------------------

  /** Look up a catalog card id by exact name. */
  async cardId(name: string): Promise<string> {
    const res = await this.client.query<{ id: string }>(
      'select id from public.cards where name = $1 limit 1',
      [name],
    )
    if (!res.rows[0]) throw new Error(`Card not in catalog: ${name}`)
    return res.rows[0].id
  }

  /** Spawn a catalog card into a zone for a seat; returns the game_card id. */
  async spawn(seat: Seat, name: string, zone: Zone, tapped = false): Promise<string> {
    const cardId = await this.cardId(name)
    await this.run(
      () =>
        rpc(this.client, 'dev_spawn_card', {
          p_session_id: this.sessionId,
          p_player_id: this.players[seat],
          p_card_id: cardId,
          p_zone: zone,
          p_tapped: tapped,
        }),
      seat,
    )
    // dev_spawn_card return shape varies; fetch the newest matching row instead.
    const res = await this.client.query<{ id: string }>(
      `select id from public.game_cards
       where session_id = $1 and owner_id = $2 and card_id = $3 and zone = $4
       order by zone_position desc limit 1`,
      [this.sessionId, this.players[seat], cardId, zone],
    )
    if (!res.rows[0]) throw new Error(`Spawn failed: ${name} (${seat}, ${zone})`)
    return res.rows[0].id
  }

  /** Convenience: spawn a creature on the battlefield with no summoning sickness. */
  async spawnCreature(seat: Seat, name: string): Promise<string> {
    const id = await this.spawn(seat, name, 'battlefield')
    await this.run(() =>
      rpc(this.client, 'dev_clear_summoning_sickness', {
        p_session_id: this.sessionId,
        p_game_card_id: id,
      }),
    )
    return id
  }

  /** Force the turn state (phase/step/active/priority). Defaults to acting seat. */
  async setTurn(opts: {
    phase: string
    step: string
    active?: Seat
    priority?: Seat
    turnNumber?: number
  }): Promise<void> {
    await this.run(() =>
      rpc(this.client, 'dev_set_turn_state', {
        p_session_id: this.sessionId,
        p_phase: opts.phase,
        p_step: opts.step,
        p_active_player_id: opts.active ? this.players[opts.active] : null,
        p_priority_player_id: opts.priority ? this.players[opts.priority] : null,
        p_turn_number: opts.turnNumber ?? null,
      }),
    )
  }

  // --- Actions -------------------------------------------------------------

  /** Put an action on the stack as the acting seat. Returns the stack item. */
  async putOnStack(
    actionType: string,
    payload: Record<string, unknown>,
    sourceCardId: string | null = null,
  ): Promise<{ id: string }> {
    return this.run(() =>
      rpc(this.client, 'put_action_on_stack', {
        p_session_id: this.sessionId,
        p_action_type: actionType,
        p_payload: { timing: 'instant', ...payload },
        p_source_card_id: sourceCardId,
      }),
    )
  }

  /** Announce a modal spell as the acting seat; returns the stack item. */
  async castModal(
    modes: { label?: string; actions: unknown[] }[],
    choose = 1,
    sourceCardId: string | null = null,
  ): Promise<{ id: string }> {
    return this.run(() =>
      rpc(this.client, 'cast_modal_spell', {
        p_session_id: this.sessionId,
        p_modes: JSON.stringify(modes),
        p_choose: choose,
        p_source_card_id: sourceCardId,
      }),
    )
  }

  /** Announce a scry as the acting seat; returns the stack item. */
  async castScry(amount = 1, sourceCardId: string | null = null): Promise<{ id: string }> {
    return this.run(() =>
      rpc(this.client, 'cast_scry', {
        p_session_id: this.sessionId,
        p_amount: amount,
        p_source_card_id: sourceCardId,
      }),
    )
  }

  /** Cast an untargeted multi-action spell (effect program) as the acting seat. */
  async castSpellEffect(
    actions: unknown[],
    sourceCardId: string | null = null,
  ): Promise<{ id: string }> {
    return this.run(() =>
      rpc(this.client, 'cast_spell_effect', {
        p_session_id: this.sessionId,
        p_actions: JSON.stringify(actions),
        p_source_card_id: sourceCardId,
      }),
    )
  }

  /** Announce a surveil as the acting seat; returns the stack item. */
  async castSurveil(amount = 1, sourceCardId: string | null = null): Promise<{ id: string }> {
    return this.run(() =>
      rpc(this.client, 'cast_surveil', {
        p_session_id: this.sessionId,
        p_amount: amount,
        p_source_card_id: sourceCardId,
      }),
    )
  }

  /** Cast a fight (fighter you control vs. another creature) as the acting seat. */
  async castFight(
    fighterCardId: string,
    foughtCardId: string,
    sourceCardId: string | null = null,
    foughtController = 'any',
  ): Promise<{ id: string }> {
    return this.run(() =>
      rpc(this.client, 'cast_fight', {
        p_session_id: this.sessionId,
        p_fighter_card_id: fighterCardId,
        p_fought_card_id: foughtCardId,
        p_source_card_id: sourceCardId,
        p_fought_controller: foughtController,
      }),
    )
  }

  /** The oldest pending decision in the session (or null). */
  async pendingDecision(): Promise<{
    id: string
    deciding_player_id: string
    source_stack_item_id: string
    decision_type: string
    options: unknown
    min_choices: number
    max_choices: number
  } | null> {
    const res = await this.client.query(
      `select id, deciding_player_id, source_stack_item_id, decision_type,
              options, min_choices, max_choices
       from public.game_pending_decisions
       where session_id = $1 and status = 'pending'
       order by created_at limit 1`,
      [this.sessionId],
    )
    return (res.rows[0] as never) ?? null
  }

  /** Submit a decision result as the acting seat. */
  async submitDecision(decisionId: string, result: unknown): Promise<unknown> {
    return this.run(() =>
      rpc(this.client, 'submit_decision', {
        p_decision_id: decisionId,
        p_result: JSON.stringify(result),
      }),
    )
  }

  /** Activate ability `index` on a source the acting seat controls. */
  async activate(
    sourceCardId: string,
    index = 0,
    target: { targetCardId?: string; targetPlayerId?: string } = {},
  ): Promise<{ id: string }> {
    return this.run(() =>
      rpc(this.client, 'activate_ability', {
        p_session_id: this.sessionId,
        p_source_card_id: sourceCardId,
        p_ability_index: index,
        p_target_player_id: target.targetPlayerId ?? null,
        p_target_card_id: target.targetCardId ?? null,
        p_generic_payment: null,
      }),
    )
  }

  /** Resolve the top of the stack (as the acting seat). */
  async resolveStack(): Promise<Record<string, unknown>> {
    return this.run(() => rpc(this.client, 'resolve_top_of_stack', { p_session_id: this.sessionId }))
  }

  /** Rebuild scripted continuous effects (e.g. after spawning a keyword creature). */
  async rebuild(): Promise<unknown> {
    return this.run(() =>
      rpc(this.client, 'rebuild_scripted_continuous_effects', { p_session_id: this.sessionId }),
    )
  }

  /** Declare the acting seat's creature as an attacker against `defender`. */
  async declareAttacker(attackerCardId: string, defender: Seat): Promise<unknown> {
    return this.run(() =>
      rpc(this.client, 'declare_attacker', {
        p_session_id: this.sessionId,
        p_attacker_card_id: attackerCardId,
        p_defending_player_id: this.players[defender],
      }),
    )
  }

  /** Declare the acting seat's creature as a blocker of `attackerCardId`. */
  async declareBlocker(blockerCardId: string, attackerCardId: string): Promise<unknown> {
    return this.run(() =>
      rpc(this.client, 'declare_blocker', {
        p_session_id: this.sessionId,
        p_blocker_card_id: blockerCardId,
        p_attacker_card_id: attackerCardId,
      }),
    )
  }

  async resolveCombat(): Promise<unknown> {
    return this.run(() => rpc(this.client, 'resolve_combat_damage', { p_session_id: this.sessionId }))
  }

  /** Run the continuous-effect expiry sweep for a step (as the acting seat). */
  async expireEffects(phase: string, step: string, turnNumber = 1): Promise<number> {
    return this.run(() =>
      rpc<number>(this.client, 'expire_continuous_effects_for_step', {
        p_session_id: this.sessionId,
        p_turn_number: turnNumber,
        p_phase: phase,
        p_step: step,
      }),
    )
  }

  // --- Inspection (runs as postgres → RLS bypassed) -----------------------

  async zoneOf(gameCardId: string): Promise<Zone> {
    const res = await this.client.query<{ zone: Zone }>(
      'select zone from public.game_cards where id = $1',
      [gameCardId],
    )
    return res.rows[0]?.zone
  }

  async cardState(gameCardId: string) {
    const res = await this.client.query(
      `select zone, is_tapped, damage_marked, plus_one_counters,
              owner_id, controller_player_id
       from public.game_cards where id = $1`,
      [gameCardId],
    )
    return res.rows[0]
  }

  async lifeOf(seat: Seat): Promise<number> {
    const res = await this.client.query<{ life_total: number }>(
      'select life_total from public.game_session_players where session_id = $1 and player_id = $2',
      [this.sessionId, this.players[seat]],
    )
    return res.rows[0]?.life_total
  }

  async zoneCount(seat: Seat, zone: Zone): Promise<number> {
    const res = await this.client.query<{ n: string }>(
      `select count(*)::int as n from public.game_cards
       where session_id = $1 and owner_id = $2 and zone = $3`,
      [this.sessionId, this.players[seat], zone],
    )
    return Number(res.rows[0]?.n ?? 0)
  }

  /** Library card ids for a seat, ordered top-to-bottom (lowest zone_position first). */
  async libraryIds(seat: Seat): Promise<string[]> {
    const res = await this.client.query<{ id: string }>(
      `select id from public.game_cards
       where session_id = $1 and owner_id = $2 and zone = 'library'
       order by zone_position asc, id asc`,
      [this.sessionId, this.players[seat]],
    )
    return res.rows.map((r) => r.id)
  }

  /** Call a public boolean accessor of shape fn(session, game_card) -> bool. */
  async cardBool(fnName: string, gameCardId: string): Promise<boolean> {
    const res = await this.client.query<{ v: boolean }>(
      `select public.${fnName}($1, $2) as v`,
      [this.sessionId, gameCardId],
    )
    return res.rows[0]?.v
  }

  async effectivePower(gameCardId: string): Promise<number> {
    const res = await this.client.query<{ v: number }>(
      'select public.card_effective_power($1, $2) as v',
      [this.sessionId, gameCardId],
    )
    return res.rows[0]?.v
  }

  async effectiveToughness(gameCardId: string): Promise<number> {
    const res = await this.client.query<{ v: number }>(
      'select public.card_effective_toughness($1, $2) as v',
      [this.sessionId, gameCardId],
    )
    return res.rows[0]?.v
  }

  async stackStatus(stackItemId: string): Promise<string> {
    const res = await this.client.query<{ status: string }>(
      'select status from public.game_stack_items where id = $1',
      [stackItemId],
    )
    return res.rows[0]?.status
  }

  async continuousEffectCount(gameCardId: string, effectType: string): Promise<number> {
    const res = await this.client.query<{ n: string }>(
      `select count(*)::int as n from public.game_continuous_effects
       where session_id = $1 and source_card_id = $2 and effect_type = $3`,
      [this.sessionId, gameCardId, effectType],
    )
    return Number(res.rows[0]?.n ?? 0)
  }

  /** The top pending stack item (highest position), or null if the stack is empty. */
  async topStackItem(): Promise<{ id: string; action_type: string; payload: Record<string, unknown> } | null> {
    const res = await this.client.query(
      `select id, action_type, payload from public.game_stack_items
       where session_id = $1 and status = 'pending' order by position desc limit 1`,
      [this.sessionId],
    )
    return (res.rows[0] as { id: string; action_type: string; payload: Record<string, unknown> }) ?? null
  }

  /** Choose the creature target for a pending targeted trigger, as the acting seat. */
  async chooseTriggerTarget(stackItemId: string, targetCardId: string): Promise<unknown> {
    return this.run(() =>
      rpc(this.client, 'choose_triggered_ability_creature_target', {
        p_session_id: this.sessionId,
        p_stack_item_id: stackItemId,
        p_target_card_id: targetCardId,
      }),
    )
  }

  async pendingStack(): Promise<{ action_type: string; payload: Record<string, unknown> }[]> {
    const res = await this.client.query(
      `select action_type, payload from public.game_stack_items
       where session_id = $1 and status = 'pending' order by position desc`,
      [this.sessionId],
    )
    return res.rows as { action_type: string; payload: Record<string, unknown> }[]
  }
}
