-- Commander (EDH) / multiplayer — skip ELIMINATED players in the turn + priority
-- loops.
--
-- The turn engine (advance_step) and priority engine (pass_priority) both rotate
-- by seat_number and were already generically N-player, and
-- maybe_finish_game_session already implements last-player-standing (alive ==
-- life_total > 0). The gap: neither rotation skipped a dead seat. In a 2-player
-- game that's invisible (the game finishes the instant one player dies), but in a
-- 3-4 player Commander game the game CONTINUES, and a player at 0 life would still
--   * be handed priority (stalling every round — they'd have to keep passing), and
--   * become the active player on their turn (untap/draw for a corpse).
--
-- Fix: an `life_total > 0` filter on
--   * pass_priority — the player COUNT that sets the all-passed threshold AND the
--     next-priority-seat lookup (both the next-higher-seat and the wrap-to-lowest);
--   * advance_step — the next-active-seat lookup at cleanup (next-higher + wrap).
--
-- Both functions are reproduced from their CURRENT definitions (pass_priority from
-- mig 095; advance_step from the baseline) with only the filters added.
-- (IDE T-SQL diagnostics false-positive on $$ bodies — ignore.)

-- ── pass_priority (from mig 095 + alive filter) ──────────────────────────────
create or replace function public.pass_priority(p_session_id uuid)
returns public.game_turn_state
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_state public.game_turn_state;
  v_session_status text;
  v_current_priority_player_id uuid;
  v_next_priority_player_id uuid;
  v_player_count integer;
  v_pending_stack_count integer;
  v_next_pass_count integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select status
  into v_session_status
  from public.game_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'Game session not found';
  end if;

  if v_session_status = 'finished' then
    raise exception 'Cannot pass priority in a finished game session';
  end if;

  -- A pending decision suspends resolution; nobody may pass/advance until it's
  -- submitted. (The parked stack item is status='awaiting_decision', so the
  -- pending-count checks below would otherwise treat the stack as empty.)
  if exists (
    select 1 from public.game_pending_decisions
    where session_id = p_session_id and status = 'pending'
  ) then
    raise exception 'A decision is pending and must be resolved before passing priority';
  end if;

  select *
  into v_current_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  v_current_priority_player_id := coalesce(
    v_current_state.priority_player_id,
    v_current_state.active_player_id
  );

  if v_current_priority_player_id <> auth.uid() then
    raise exception 'Only the priority player can pass priority';
  end if;

  -- Only living players take part in the priority round.
  select count(*)
  into v_player_count
  from public.game_session_players
  where session_id = p_session_id
    and life_total > 0;

  if v_player_count <= 1 then
    select count(*)
    into v_pending_stack_count
    from public.game_stack_items
    where session_id = p_session_id
      and status = 'pending';

    if v_pending_stack_count > 0 then
      perform public.resolve_top_of_stack(p_session_id);

      select *
      into v_current_state
      from public.game_turn_state
      where session_id = p_session_id;

      return v_current_state;
    end if;

    return public.advance_step(p_session_id);
  end if;

  v_next_pass_count := coalesce(v_current_state.priority_pass_count, 0) + 1;

  if v_next_pass_count >= v_player_count then
    select count(*)
    into v_pending_stack_count
    from public.game_stack_items
    where session_id = p_session_id
      and status = 'pending';

    if v_pending_stack_count > 0 then
      perform public.resolve_top_of_stack(p_session_id);

      select *
      into v_current_state
      from public.game_turn_state
      where session_id = p_session_id;

      return v_current_state;
    end if;

    return public.advance_step(p_session_id);
  end if;

  -- Next living player by seat order (skip eliminated seats).
  select next_player.player_id
  into v_next_priority_player_id
  from public.game_session_players current_player
  join public.game_session_players next_player
    on next_player.session_id = current_player.session_id
   and next_player.seat_number > current_player.seat_number
   and next_player.life_total > 0
  where current_player.session_id = p_session_id
    and current_player.player_id = v_current_priority_player_id
  order by next_player.seat_number
  limit 1;

  if v_next_priority_player_id is null then
    select player_id
    into v_next_priority_player_id
    from public.game_session_players
    where session_id = p_session_id
      and life_total > 0
    order by seat_number
    limit 1;
  end if;

  if v_next_priority_player_id is null then
    raise exception 'No players found for game session';
  end if;

  update public.game_turn_state
  set
    priority_player_id = v_next_priority_player_id,
    priority_cycle_started_by = coalesce(
      priority_cycle_started_by,
      v_current_priority_player_id
    ),
    priority_pass_count = v_next_pass_count
  where session_id = p_session_id
  returning * into v_current_state;

  return v_current_state;
end;
$$;

grant execute on function public.pass_priority(uuid) to authenticated;

-- ── advance_step (from baseline + alive filter at the cleanup rotation) ───────
create or replace function public.advance_step(p_session_id uuid)
returns public.game_turn_state
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_state public.game_turn_state;
  v_session_status text;
  v_required_player_id uuid;
  v_next_active_player_id uuid;
  v_next_priority_player_id uuid;
  v_next_phase text;
  v_next_step text;
  v_next_turn_number integer;
  v_next_lands_played_this_turn integer;
  v_drawn_card_id uuid;
  v_next_hand_position integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select status
  into v_session_status
  from public.game_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'Game session not found';
  end if;

  if v_session_status = 'finished' then
    raise exception 'Cannot advance a finished game session';
  end if;

  select *
  into v_current_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  v_required_player_id := coalesce(v_current_state.priority_player_id, v_current_state.active_player_id);

  if v_required_player_id <> auth.uid() then
    raise exception 'Only the priority player can advance the step';
  end if;

  perform public.clear_mana_pool_for_step(
    p_session_id,
    v_current_state.phase,
    v_current_state.step
  );

  perform public.expire_continuous_effects_for_step(
    p_session_id,
    v_current_state.turn_number,
    v_current_state.phase,
    v_current_state.step
  );

  v_next_active_player_id := v_current_state.active_player_id;
  v_next_priority_player_id := v_current_state.active_player_id;
  v_next_turn_number := v_current_state.turn_number;
  v_next_lands_played_this_turn := coalesce(v_current_state.lands_played_this_turn, 0);
  v_next_phase := v_current_state.phase;
  v_next_step := v_current_state.step;

  case v_current_state.step
    when 'untap' then
      delete from public.game_combat_assignments
      where session_id = p_session_id;

      update public.game_cards
      set is_tapped = false
      where session_id = p_session_id
        and owner_id = v_current_state.active_player_id
        and zone = 'battlefield'
        and is_tapped = true;

      v_next_phase := 'beginning';
      v_next_step := 'upkeep';
    when 'upkeep' then
      v_next_phase := 'beginning';
      v_next_step := 'draw';
    when 'draw' then
      select coalesce(max(zone_position), -1) + 1
      into v_next_hand_position
      from public.game_cards
      where session_id = p_session_id
        and owner_id = v_current_state.active_player_id
        and zone = 'hand';

      select id
      into v_drawn_card_id
      from public.game_cards
      where session_id = p_session_id
        and owner_id = v_current_state.active_player_id
        and zone = 'library'
      order by zone_position asc, id asc
      limit 1
      for update skip locked;

      if v_drawn_card_id is null then
        raise exception 'Library is empty';
      end if;

      update public.game_cards
      set
        zone = 'hand',
        zone_position = v_next_hand_position,
        is_tapped = false,
        damage_marked = 0
      where id = v_drawn_card_id;

      v_next_phase := 'main_1';
      v_next_step := 'precombat_main';
    when 'precombat_main' then
      v_next_phase := 'combat';
      v_next_step := 'beginning_of_combat';
    when 'beginning_of_combat' then
      v_next_phase := 'combat';
      v_next_step := 'declare_attackers';
    when 'declare_attackers' then
      v_next_phase := 'combat';
      v_next_step := 'declare_blockers';

      select defending_player_id
      into v_next_priority_player_id
      from public.game_combat_assignments
      where session_id = p_session_id
        and turn_number = v_current_state.turn_number
        and blocker_card_id is null
      order by created_at
      limit 1;

      v_next_priority_player_id := coalesce(v_next_priority_player_id, v_current_state.active_player_id);
    when 'declare_blockers' then
      v_next_priority_player_id := v_current_state.active_player_id;
      v_next_phase := 'combat';
      v_next_step := 'combat_damage';
    when 'combat_damage' then
      v_next_phase := 'combat';
      v_next_step := 'end_of_combat';
    when 'end_of_combat' then
      delete from public.game_combat_assignments
      where session_id = p_session_id;

      v_next_phase := 'main_2';
      v_next_step := 'postcombat_main';
    when 'postcombat_main' then
      v_next_phase := 'ending';
      v_next_step := 'end';
    when 'end' then
      v_next_phase := 'ending';
      v_next_step := 'cleanup';
    when 'cleanup' then
      delete from public.game_combat_assignments
      where session_id = p_session_id;

      update public.game_cards
      set damage_marked = 0
      where session_id = p_session_id
        and damage_marked <> 0;

      -- Hand the turn to the next LIVING player by seat order (skip eliminated).
      select next_player.player_id
      into v_next_active_player_id
      from public.game_session_players current_player
      join public.game_session_players next_player
        on next_player.session_id = current_player.session_id
       and next_player.seat_number > current_player.seat_number
       and next_player.life_total > 0
      where current_player.session_id = p_session_id
        and current_player.player_id = v_current_state.active_player_id
      order by next_player.seat_number
      limit 1;

      if v_next_active_player_id is null then
        select player_id
        into v_next_active_player_id
        from public.game_session_players
        where session_id = p_session_id
          and life_total > 0
        order by seat_number
        limit 1;
      end if;

      if v_next_active_player_id is null then
        raise exception 'No players found for game session';
      end if;

      v_next_priority_player_id := v_next_active_player_id;
      v_next_turn_number := v_current_state.turn_number + 1;
      v_next_lands_played_this_turn := 0;
      v_next_phase := 'beginning';
      v_next_step := 'untap';
    else
      raise exception 'Unsupported turn step: %', v_current_state.step;
  end case;

  update public.game_turn_state
  set
    active_player_id = v_next_active_player_id,
    priority_player_id = v_next_priority_player_id,
    priority_cycle_started_by = null,
    priority_pass_count = 0,
    lands_played_this_turn = v_next_lands_played_this_turn,
    turn_number = v_next_turn_number,
    phase = v_next_phase,
    step = v_next_step
  where session_id = p_session_id
  returning * into v_current_state;

  return v_current_state;
end;
$$;

grant execute on function public.advance_step(uuid) to authenticated;
