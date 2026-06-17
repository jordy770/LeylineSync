-- 202605010318_opening_hand_gate
-- TODO: describe the change.
-- Generated from supabase/functions_src (pass_priority) — those files are
-- the canonical current definitions; edit them, not past migrations.

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
  v_player_count integer;
  v_pending_stack_count integer;
  v_next_pass_count integer;
  v_cursor_player uuid;
  v_next_player uuid;
  v_chaining boolean;
  v_settings jsonb;
  v_would_pass boolean;
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

  -- Pre-game: no priority passing / turn progression until EVERY player has kept
  -- their opening hand. Otherwise an auto-passing client (solo especially) advances
  -- through untap/upkeep/draw and draws an 8th card while the mulligan is still open.
  if exists (
    select 1 from public.game_session_players
    where session_id = p_session_id and opening_hand_kept = false
  ) then
    raise exception 'All players must keep their opening hand before play begins';
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

  select count(*)
  into v_pending_stack_count
  from public.game_stack_items
  where session_id = p_session_id
    and status = 'pending';

  -- Single living player: resolve the stack or advance the step, as before.
  if v_player_count <= 1 then
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

  -- Pod auto-skip is only safe on an EMPTY stack and outside declare_blockers
  -- (blocks are submitted, not passed). When chaining is off, the loop below
  -- runs exactly once and simply hands priority to the next living seat — the
  -- pre-existing behavior.
  v_chaining := (v_pending_stack_count = 0
                 and v_current_state.step <> 'declare_blockers');

  -- The caller's own pass.
  v_next_pass_count := coalesce(v_current_state.priority_pass_count, 0) + 1;
  v_cursor_player := v_current_priority_player_id;

  loop
    -- The round is complete: everyone (incl. any auto-skipped) has passed.
    exit when v_next_pass_count >= v_player_count;

    -- Next living player by seat order after the cursor (wrap to the lowest seat).
    select next_player.player_id
    into v_next_player
    from public.game_session_players current_player
    join public.game_session_players next_player
      on next_player.session_id = current_player.session_id
     and next_player.seat_number > current_player.seat_number
     and next_player.life_total > 0
    where current_player.session_id = p_session_id
      and current_player.player_id = v_cursor_player
    order by next_player.seat_number
    limit 1;

    if v_next_player is null then
      select player_id
      into v_next_player
      from public.game_session_players
      where session_id = p_session_id
        and life_total > 0
      order by seat_number
      limit 1;
    end if;

    v_cursor_player := v_next_player;

    -- Not chaining: priority simply lands on this next seat.
    exit when not v_chaining;

    -- Would this player auto-pass right here, per their persisted settings? This
    -- mirrors the client's auto-pass decision (empty stack already guaranteed).
    select autopass_settings
    into v_settings
    from public.game_session_players
    where session_id = p_session_id
      and player_id = v_cursor_player;

    if v_cursor_player = v_current_state.active_player_id then
      v_would_pass := coalesce((v_settings ->> 'own')::boolean, false)
        and v_current_state.step in
          ('untap', 'upkeep', 'draw', 'beginning_of_combat', 'end_of_combat', 'end');
    else
      v_would_pass := coalesce((v_settings ->> 'op')::boolean, false)
        and not coalesce((v_settings ->> 'rsp')::boolean, false);
    end if;

    -- They'd stop here: hand them priority.
    exit when not v_would_pass;

    -- They'd auto-pass: count it and keep walking the round.
    v_next_pass_count := v_next_pass_count + 1;
  end loop;

  if v_next_pass_count >= v_player_count then
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

  update public.game_turn_state
  set
    priority_player_id = v_cursor_player,
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
