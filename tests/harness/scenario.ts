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

export type Seat = 'A' | 'B' | 'C' | 'D'
export type Zone = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'stack' | 'command'

export class Scenario {
  private constructor(
    readonly client: Client,
    readonly sessionId: string,
    readonly players: Record<Seat, string>,
    private acting: Seat = 'A',
  ) {}

  /**
   * Create a session. Seat A is the creator + active player; B/C/D join in seat
   * order up to numPlayers. Pass numPlayers: 3 for multi-opponent tests (e.g.
   * "each opponent sacrifices") or 4 for multiplayer Commander turn/priority/win
   * tests. Unjoined seats' UUIDs always exist for typing but aren't session players.
   */
  static async create(
    client: Client,
    numPlayers: 2 | 3 | 4 = 2,
    opts: { format?: 'standard' | 'commander' } = {},
  ): Promise<Scenario> {
    const players: Record<Seat, string> = {
      A: randomUUID(),
      B: randomUUID(),
      C: randomUUID(),
      D: randomUUID(),
    }

    // Note: the auth/profiles FKs are dropped locally by migration
    // 00000000000001_local_test_relax_fks.sql, so throwaway player UUIDs need no
    // auth.users / profiles rows.
    const sessionId = await asPlayer(client, players.A, () =>
      rpc<string>(client, 'create_game_session', opts.format ? { p_format: opts.format } : {}),
    )
    const joinOrder: Seat[] = ['B', 'C', 'D']
    for (const seat of joinOrder.slice(0, numPlayers - 1)) {
      await asPlayer(client, players[seat], () =>
        rpc(client, 'join_game_session', { p_session_id: sessionId }),
      )
    }

    return new Scenario(client, sessionId, players)
  }

  /** Set the seat whose priority/identity subsequent actions run as. */
  as(seat: Seat): this {
    this.acting = seat
    return this
  }

  /** The player UUID backing a seat (for asserting controller/owner ids). */
  playerId(seat: Seat): string {
    return this.players[seat]
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

  /** Set a seat's mana pool directly (runs as postgres → RLS bypassed). */
  async setMana(seat: Seat, pool: Partial<Record<'W' | 'U' | 'B' | 'R' | 'G' | 'C', number>>): Promise<void> {
    const full = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, ...pool }
    await this.client.query(
      `insert into public.game_players (session_id, player_id, mana_pool)
       values ($1, $2, $3::jsonb)
       on conflict (session_id, player_id) do update set mana_pool = excluded.mana_pool`,
      [this.sessionId, this.players[seat], JSON.stringify(full)],
    )
  }

  /**
   * Pay a mana cost as the acting seat (direct pay_mana_cost call). Returns the
   * resulting mana pool. `hybrid` is the per-symbol choice array for {W/U}/{2/W}/
   * {W/P} symbols (colour letter, 'LIFE', or 'GENERIC'); omit it to auto-resolve.
   */
  async payMana(
    seat: Seat,
    cost: string,
    opts: { generic?: Record<string, number>; xValue?: number; hybrid?: string[] } = {},
  ): Promise<Record<string, number>> {
    return this.run(
      () =>
        rpc(this.client, 'pay_mana_cost', {
          p_session_id: this.sessionId,
          p_player_id: this.players[seat],
          p_mana_cost: cost,
          p_generic_payment: opts.generic ? JSON.stringify(opts.generic) : null,
          p_x_value: opts.xValue ?? 0,
          p_hybrid_payment: opts.hybrid ? JSON.stringify(opts.hybrid) : null,
        }),
      seat,
    )
  }

  // --- Actions -------------------------------------------------------------

  /** Set a creature's base power/toughness (layer 7b). Returns the effect id. */
  async setBasePT(card: string, power: number, toughness: number, seat: Seat = this.acting): Promise<string> {
    return this.run(
      () =>
        rpc(this.client, 'add_set_pt_effect', {
          p_session_id: this.sessionId,
          p_affected_card_id: card,
          p_power: power,
          p_toughness: toughness,
          p_source_card_id: null,
        }),
      seat,
    )
  }

  /** Switch a creature's power and toughness (layer 7e). Returns the effect id. */
  async addSwitchPt(card: string, seat: Seat = this.acting): Promise<string> {
    return this.run(
      () =>
        rpc<string>(this.client, 'add_switch_pt_effect', {
          p_session_id: this.sessionId,
          p_affected_card_id: card,
          p_source_card_id: null,
        }),
      seat,
    )
  }

  /** Create a damage-prevention shield protecting a player. amount null = prevent all. */
  async addPrevention(
    player: Seat,
    amount: number | null = null,
    combatOnly = false,
    seat: Seat = this.acting,
  ): Promise<string> {
    return this.run(
      () =>
        rpc(this.client, 'add_damage_prevention', {
          p_session_id: this.sessionId,
          p_player_id: this.players[player],
          p_amount: amount,
          p_combat_only: combatOnly,
          p_source_card_id: null,
        }),
      seat,
    )
  }

  /** Create a damage-prevention shield protecting a CREATURE. amount null = prevent all. */
  async addCreaturePrevention(
    card: string,
    amount: number | null = null,
    combatOnly = false,
    seat: Seat = this.acting,
  ): Promise<string> {
    return this.run(
      () =>
        rpc<string>(this.client, 'add_creature_damage_prevention', {
          p_session_id: this.sessionId,
          p_card_id: card,
          p_amount: amount,
          p_combat_only: combatOnly,
          p_source_card_id: null,
        }),
      seat,
    )
  }

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

  /**
   * Cast a permanent (creature/enchantment/artifact/aura) from hand as the acting
   * seat. For an Aura, pass `target` (the creature to enchant). Returns the card row.
   */
  async castPermanent(
    gameCardId: string,
    opts: { target?: string; generic?: Record<string, number>; kicked?: boolean; sacrificeIds?: string[]; x?: number } = {},
  ): Promise<{ id: string }> {
    return this.run(() =>
      rpc(this.client, 'cast_card_from_hand', {
        p_session_id: this.sessionId,
        p_game_card_id: gameCardId,
        p_generic_payment: opts.generic ? JSON.stringify(opts.generic) : null,
        p_target_card_id: opts.target ?? null,
        p_kicked: opts.kicked ?? false,
        p_sacrifice_ids: opts.sacrificeIds ?? null,
        p_x_value: opts.x ?? null,
      }),
    )
  }

  /** Create a deck for a seat (list_data + optional commander); returns the deck id. */
  async createDeck(seat: Seat, cardNames: string[], commanderName?: string): Promise<string> {
    const ids = await Promise.all(cardNames.map((n) => this.cardId(n)))
    const commanderId = commanderName ? await this.cardId(commanderName) : null
    const res = await this.client.query<{ id: string }>(
      `insert into public.decks (owner_id, name, list_data, commander_card_id, created_by)
       values ($1, $2, $3::jsonb, $4, $1)
       returning id`,
      [this.players[seat], 'Test Deck', JSON.stringify(ids), commanderId],
    )
    return res.rows[0]!.id
  }

  /** Create a shared precon deck (is_precon, ownerless) selectable by any player; returns its id. */
  async createPreconDeck(name: string, cardNames: string[], commanderName?: string): Promise<string> {
    const ids = await Promise.all(cardNames.map((n) => this.cardId(n)))
    const commanderId = commanderName ? await this.cardId(commanderName) : null
    const res = await this.client.query<{ id: string }>(
      `insert into public.decks (owner_id, name, list_data, commander_card_id, created_by, is_precon)
       values (null, $1, $2::jsonb, $3, null, true)
       returning id`,
      [name, JSON.stringify(ids), commanderId],
    )
    return res.rows[0]!.id
  }

  /** Import a deck from decklist text as the acting seat; returns the import result. */
  async importDeck(
    name: string,
    decklist: string,
  ): Promise<{ id: string | null; card_count: number; commander_card_id: string | null }> {
    return this.run(() =>
      rpc(this.client, 'import_deck_from_text', { p_name: name, p_decklist: decklist }),
    )
  }

  /** Set a deck's commander, as the acting seat. */
  async setDeckCommander(deckId: string, commanderName: string): Promise<void> {
    const cardId = await this.cardId(commanderName)
    return this.run(() =>
      rpc(this.client, 'set_deck_commander', { p_deck_id: deckId, p_card_id: cardId }),
    )
  }

  /** Read a deck's commander_card_id (or null). */
  async deckCommander(deckId: string): Promise<string | null> {
    const res = await this.client.query<{ commander_card_id: string | null }>(
      'select commander_card_id from public.decks where id = $1',
      [deckId],
    )
    return res.rows[0]?.commander_card_id ?? null
  }

  /**
   * Seed a deck into the session for the acting seat (library + commander to command
   * zone). Legality enforcement defaults OFF so minimal test fixtures can seed; pass
   * { enforceLegality: true } to exercise the Commander legality gate.
   */
  async spawnDeck(
    deckId: string,
    opts: { enforceLegality?: boolean } = {},
  ): Promise<{ library: number; commander_seeded: boolean }> {
    return this.run(() =>
      rpc(this.client, 'spawn_deck_for_session', {
        p_session_id: this.sessionId,
        p_deck_id: deckId,
        p_enforce_legality: opts.enforceLegality ?? false,
      }),
    )
  }

  /** The server's Commander legality verdict for a deck, as the acting seat. */
  async commanderDeckLegality(
    deckId: string,
  ): Promise<{ legal: boolean; card_count: number; issues: string[] }> {
    return this.run(() =>
      rpc(this.client, 'commander_deck_legality', { p_deck_id: deckId }),
    )
  }

  /** Deal damage to a player through the resolver (commander-aware), as the acting seat. */
  async applyDamageToPlayer(
    defender: Seat,
    amount: number,
    sourceCardId: string | null,
    isCombat = false,
  ): Promise<number> {
    return this.run(() =>
      rpc<number>(this.client, 'apply_damage_to_player', {
        p_session_id: this.sessionId,
        p_player_id: this.players[defender],
        p_amount: amount,
        p_source_card_id: sourceCardId,
        p_is_combat: isCombat,
      }),
    )
  }

  /** Cumulative commander damage dealt to a seat by a given commander source. */
  async commanderDamage(defender: Seat, sourceCardId: string): Promise<number> {
    const res = await this.client.query<{ damage: number }>(
      `select damage from public.game_commander_damage
       where session_id = $1 and defender_player_id = $2 and source_card_id = $3`,
      [this.sessionId, this.players[defender], sourceCardId],
    )
    return Number(res.rows[0]?.damage ?? 0)
  }

  /** Insert a commander into a seat's command zone (or another zone); returns the id. */
  async spawnCommander(seat: Seat, name: string, zone: Zone = 'command'): Promise<string> {
    const cardId = await this.cardId(name)
    const res = await this.client.query<{ id: string }>(
      `insert into public.game_cards
         (session_id, card_id, owner_id, controller_player_id, zone, zone_position, is_commander)
       values ($1, $2, $3, $3, $4, 0, true)
       returning id`,
      [this.sessionId, cardId, this.players[seat], zone],
    )
    return res.rows[0]!.id
  }

  /** Set a seat's commander-return preference (acts as that seat). */
  async setCommanderRedirect(seat: Seat, redirect: boolean): Promise<void> {
    return this.run(
      () =>
        rpc(this.client, 'set_commander_redirect', {
          p_session_id: this.sessionId,
          p_redirect: redirect,
        }),
      seat,
    )
  }

  /** Cast the acting seat's commander from the command zone (pays cost + tax). */
  async castCommander(cardId: string, opts: { generic?: Record<string, number> } = {}): Promise<{ id: string }> {
    return this.run(() =>
      rpc(this.client, 'cast_commander', {
        p_session_id: this.sessionId,
        p_game_card_id: cardId,
        p_generic_payment: opts.generic ? JSON.stringify(opts.generic) : null,
      }),
    )
  }

  /** Mark the session as Commander (format + 40 life), as the acting seat. */
  async setCommanderFormat(): Promise<void> {
    return this.run(() => rpc(this.client, 'set_commander_format', { p_session_id: this.sessionId }))
  }

  /** Move a battlefield card to the graveyard via the engine chokepoint (commander-aware). */
  async putInGraveyard(cardId: string): Promise<boolean> {
    return this.run(() =>
      rpc<boolean>(this.client, 'put_in_graveyard', { p_session_id: this.sessionId, p_game_card_id: cardId }),
    )
  }

  /** Equip an Equipment you control onto a creature you control, as the acting seat. */
  async equip(
    equipmentCardId: string,
    targetCardId: string,
    opts: { generic?: Record<string, number> } = {},
  ): Promise<{ id: string }> {
    return this.run(() =>
      rpc(this.client, 'equip', {
        p_session_id: this.sessionId,
        p_equipment_card_id: equipmentCardId,
        p_target_card_id: targetCardId,
        p_generic_payment: opts.generic ? JSON.stringify(opts.generic) : null,
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
    xValue: number | null = null,
    targetCardId: string | null = null,
    adventure = false,
  ): Promise<{ id: string }> {
    return this.run(() =>
      rpc(this.client, 'cast_spell_effect', {
        p_session_id: this.sessionId,
        p_actions: JSON.stringify(actions),
        p_source_card_id: sourceCardId,
        p_x_value: xValue,
        p_target_card_id: targetCardId,
        p_adventure: adventure,
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
    params: Record<string, unknown>
  } | null> {
    const res = await this.client.query(
      `select id, deciding_player_id, source_stack_item_id, decision_type,
              options, min_choices, max_choices, params
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
    target: { targetCardId?: string; targetPlayerId?: string; xValue?: number; costCardIds?: string[] } = {},
  ): Promise<{ id: string }> {
    return this.run(() =>
      rpc(this.client, 'activate_ability', {
        p_session_id: this.sessionId,
        p_source_card_id: sourceCardId,
        p_ability_index: index,
        p_target_player_id: target.targetPlayerId ?? null,
        p_target_card_id: target.targetCardId ?? null,
        p_generic_payment: null,
        p_x_value: target.xValue ?? null,
        p_cost_card_ids: target.costCardIds ?? null,
      }),
    )
  }

  /** Activate a mana ability (cost + multi-colour) as the acting seat; returns the pool. */
  async activateMana(
    sourceCardId: string,
    index = 0,
    generic: Record<string, number> | null = null,
    chosenColor: string | null = null,
  ): Promise<Record<string, number>> {
    return this.run(() =>
      rpc(this.client, 'activate_mana_ability', {
        p_session_id: this.sessionId,
        p_source_card_id: sourceCardId,
        p_ability_index: index,
        p_generic_payment: generic,
        p_chosen_color: chosenColor,
      }),
    ) as Promise<Record<string, number>>
  }

  /** Cycle a card from the acting seat's hand (discard it, draw one). */
  async cycle(cardId: string, generic: Record<string, number> | null = null): Promise<string | null> {
    return this.run(() =>
      rpc(this.client, 'cycle_card', {
        p_session_id: this.sessionId,
        p_game_card_id: cardId,
        p_generic_payment: generic,
      }),
    ) as Promise<string | null>
  }

  /** Activate loyalty ability `index` on a planeswalker the acting seat controls. */
  async activateLoyalty(sourceCardId: string, index = 0): Promise<unknown> {
    return this.run(() =>
      rpc(this.client, 'activate_loyalty_ability', {
        p_session_id: this.sessionId,
        p_source_card_id: sourceCardId,
        p_ability_index: index,
      }),
    )
  }

  /** Pass priority as the acting seat (rotates priority; resolves/advances once all pass). */
  async passPriority(seat: Seat = this.acting): Promise<unknown> {
    return this.run(() => rpc(this.client, 'pass_priority', { p_session_id: this.sessionId }), seat)
  }

  /** Persist a seat's server-side auto-pass intent (the {op,own,stk,rsp} blob). */
  async setAutoPass(seat: Seat, settings: Record<string, boolean>): Promise<void> {
    await this.client.query(
      `update public.game_session_players set autopass_settings = $3::jsonb
       where session_id = $1 and player_id = $2`,
      [this.sessionId, this.players[seat], JSON.stringify(settings)],
    )
  }

  /** Current turn step + active player (for pod auto-skip assertions). */
  async turnStep(): Promise<{ step: string; phase: string; active_player_id: string }> {
    const res = await this.client.query<{ step: string; phase: string; active_player_id: string }>(
      'select step, phase, active_player_id from public.game_turn_state where session_id = $1',
      [this.sessionId],
    )
    return res.rows[0]
  }

  /** Advance one turn step as the acting seat; returns the resulting turn-state row. */
  async advanceStep(seat: Seat = this.acting): Promise<{ active_player_id: string; priority_player_id: string; phase: string; step: string; turn_number: number }> {
    return this.run(
      () => rpc(this.client, 'advance_step', { p_session_id: this.sessionId }),
      seat,
    )
  }

  /** Adjust a seat's life (acts as that seat); routes through the wired finish-check. */
  async adjustLife(seat: Seat, delta: number): Promise<unknown> {
    return this.run(
      () =>
        rpc(this.client, 'adjust_player_life', {
          p_session_id: this.sessionId,
          p_target_player_id: this.players[seat],
          p_delta: delta,
        }),
      seat,
    )
  }

  /** Eliminate a seat by dropping its life to 0 (acts as that seat). */
  async eliminate(seat: Seat): Promise<void> {
    const life = await this.lifeOf(seat)
    if (life > 0) await this.adjustLife(seat, -life)
  }

  /** The current active player's UUID. */
  async activePlayer(): Promise<string> {
    const res = await this.client.query<{ active_player_id: string }>(
      'select active_player_id from public.game_turn_state where session_id = $1',
      [this.sessionId],
    )
    return res.rows[0]?.active_player_id
  }

  /** Force the session to 'finished' (test setup for cleanup). Runs as postgres. */
  async markFinished(): Promise<void> {
    await this.client.query("update public.game_sessions set status = 'finished' where id = $1", [
      this.sessionId,
    ])
  }

  /** Delete a finished session's runtime data, as the acting seat. */
  async cleanupSession(): Promise<{ cleaned: boolean; cards_deleted: number }> {
    return this.run(() =>
      rpc(this.client, 'cleanup_finished_session', { p_session_id: this.sessionId }),
    )
  }

  /** Session finished-state + winner (for last-player-standing assertions). */
  async sessionResult(): Promise<{ status: string; winner_player_id: string | null }> {
    const res = await this.client.query<{ status: string; winner_player_id: string | null }>(
      'select status, winner_player_id from public.game_sessions where id = $1',
      [this.sessionId],
    )
    return res.rows[0]
  }

  /** Current priority holder + consecutive-pass count. */
  async priorityState(): Promise<{ priority_player_id: string; priority_pass_count: number }> {
    const res = await this.client.query<{ priority_player_id: string; priority_pass_count: number }>(
      'select priority_player_id, priority_pass_count from public.game_turn_state where session_id = $1',
      [this.sessionId],
    )
    return res.rows[0]
  }

  /** Count of pending stack items. */
  async pendingCount(): Promise<number> {
    const res = await this.client.query<{ n: number }>(
      `select count(*)::int as n from public.game_stack_items where session_id = $1 and status = 'pending'`,
      [this.sessionId],
    )
    return res.rows[0]?.n ?? 0
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
  async declareAttacker(attackerCardId: string, defender: Seat, exert = false): Promise<unknown> {
    return this.run(() =>
      rpc(this.client, 'declare_attacker', {
        p_session_id: this.sessionId,
        p_attacker_card_id: attackerCardId,
        p_defending_player_id: this.players[defender],
        p_exert: exert,
      }),
    )
  }

  /** Declare `attackerCardId` attacking a planeswalker (its controller is derived). */
  async declareAttackerVsPlaneswalker(attackerCardId: string, planeswalkerCardId: string): Promise<unknown> {
    return this.run(() =>
      rpc(this.client, 'declare_attacker', {
        p_session_id: this.sessionId,
        p_attacker_card_id: attackerCardId,
        p_defending_player_id: null,
        p_defending_planeswalker_id: planeswalkerCardId,
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

  /**
   * Resolve combat damage as the acting seat. Pass `assignments` (attacker id ->
   * { blockers: [{blocker_card_id, amount}], trample? }) for player-chosen
   * over-assignment; omit it for the engine's auto minimum-lethal distribution.
   */
  /** Fire the given trigger events on a card (enqueues matching triggered abilities). */
  async fireTriggers(seat: Seat, cardId: string, events: string[]): Promise<unknown> {
    return this.run(() =>
      rpc(this.client, 'fire_card_triggers', {
        p_session_id: this.sessionId,
        p_game_card_id: cardId,
        p_events: events,
      }),
      seat,
    )
  }

  /** Settle the pending simultaneous-trigger batch into APNAP order. */
  async orderTriggers(seat: Seat = 'A'): Promise<unknown> {
    return this.run(() =>
      rpc(this.client, 'order_pending_triggers', { p_session_id: this.sessionId }),
      seat,
    )
  }

  async resolveCombat(
    assignments?: Record<string, { blockers?: { blocker_card_id: string; amount: number }[]; trample?: number }>,
  ): Promise<Record<string, unknown>> {
    return this.run(() =>
      rpc(this.client, 'resolve_combat_damage', {
        p_session_id: this.sessionId,
        p_assignments: assignments ? JSON.stringify(assignments) : null,
      }),
    )
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

  /** Tap a source for mana (add_mana_from_card), as the acting seat. */
  async addManaFromCard(
    card: string,
    color: string,
    opts: { commanderIdentity?: boolean; tap?: boolean; amount?: number } = {},
    seat: Seat = this.acting,
  ): Promise<Record<string, number>> {
    return this.run(
      () =>
        rpc(this.client, 'add_mana_from_card', {
          p_game_card_id: card,
          p_session_id: this.sessionId,
          p_player_id: this.players[seat],
          p_color: color,
          p_amount: opts.amount ?? 1,
          p_should_tap_card: opts.tap ?? false,
          p_commander_identity: opts.commanderIdentity ?? false,
        }),
      seat,
    )
  }

  /** A seat's current mana pool (defaults to an all-zero pool if unset). */
  async manaOf(seat: Seat): Promise<Record<string, number>> {
    const res = await this.client.query<{ mana_pool: Record<string, number> }>(
      'select mana_pool from public.game_players where session_id = $1 and player_id = $2',
      [this.sessionId, this.players[seat]],
    )
    return res.rows[0]?.mana_pool ?? { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }
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

  /** Choose up to N targets for a pending multi-target trigger, as the acting seat. */
  async chooseTriggerTargets(stackItemId: string, targetCardIds: string[]): Promise<unknown> {
    return this.run(() =>
      rpc(this.client, 'choose_triggered_ability_targets', {
        p_session_id: this.sessionId,
        p_stack_item_id: stackItemId,
        p_target_card_ids: targetCardIds,
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
