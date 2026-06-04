-- Phase 1, slice 8: a pending decision freezes priority.
--
-- When a stack item parks for a scry/surveil/modal decision it becomes
-- status='awaiting_decision' (no longer 'pending'). pass_priority counts only
-- 'pending' items, so once a scry parked it saw an "empty" stack and advanced the
-- step — the game moved on while a decision was still open, and players could keep
-- passing. A pending decision is mid-resolution: nothing should advance until it's
-- submitted (submit_decision resumes + finalizes, which resets priority cleanly).
--
-- Reproduced from the baseline pass_priority with a guard added at the top.
-- (IDE T-SQL diagnostics false-positive on $$ bodies — ignore.)

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

  select count(*)
  into v_player_count
  from public.game_session_players
  where session_id = p_session_id;

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

  select next_player.player_id
  into v_next_priority_player_id
  from public.game_session_players current_player
  join public.game_session_players next_player
    on next_player.session_id = current_player.session_id
   and next_player.seat_number > current_player.seat_number
  where current_player.session_id = p_session_id
    and current_player.player_id = v_current_priority_player_id
  order by next_player.seat_number
  limit 1;

  if v_next_priority_player_id is null then
    select player_id
    into v_next_priority_player_id
    from public.game_session_players
    where session_id = p_session_id
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
