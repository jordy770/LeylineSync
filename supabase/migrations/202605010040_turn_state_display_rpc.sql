create or replace function public.get_turn_state(
  p_session_id uuid
)
returns table (
  session_id uuid,
  active_player_id uuid,
  active_username text,
  priority_player_id uuid,
  priority_username text,
  priority_cycle_started_by uuid,
  priority_pass_count integer,
  lands_played_this_turn integer,
  turn_number integer,
  phase text,
  step text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    turn_state.session_id,
    turn_state.active_player_id,
    coalesce(nullif(active_profiles.username, ''), left(turn_state.active_player_id::text, 8)) as active_username,
    coalesce(turn_state.priority_player_id, turn_state.active_player_id) as priority_player_id,
    coalesce(
      nullif(priority_profiles.username, ''),
      nullif(active_profiles.username, ''),
      left(coalesce(turn_state.priority_player_id, turn_state.active_player_id)::text, 8)
    ) as priority_username,
    turn_state.priority_cycle_started_by,
    coalesce(turn_state.priority_pass_count, 0) as priority_pass_count,
    coalesce(turn_state.lands_played_this_turn, 0) as lands_played_this_turn,
    turn_state.turn_number,
    turn_state.phase,
    turn_state.step,
    turn_state.created_at,
    turn_state.updated_at
  from public.game_turn_state turn_state
  left join public.profiles active_profiles
    on active_profiles.id = turn_state.active_player_id
  left join public.profiles priority_profiles
    on priority_profiles.id = coalesce(turn_state.priority_player_id, turn_state.active_player_id)
  where turn_state.session_id = p_session_id
    and public.is_session_player(p_session_id, auth.uid());
$$;

grant execute on function public.get_turn_state(uuid) to authenticated;
