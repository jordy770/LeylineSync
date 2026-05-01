create or replace function public.get_combat_action_state(
  p_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_turn_state public.game_turn_state;
  v_is_session_player boolean;
  v_reason text;
begin
  if auth.uid() is null then
    return jsonb_build_object(
      'can_declare_attackers', false,
      'reason', 'Authentication required'
    );
  end if;

  v_is_session_player := public.is_session_player(p_session_id, auth.uid());

  if not v_is_session_player then
    return jsonb_build_object(
      'can_declare_attackers', false,
      'reason', 'Current user is not a player in this session'
    );
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = p_session_id;

  if not found then
    return jsonb_build_object(
      'can_declare_attackers', false,
      'reason', 'Turn state not found'
    );
  end if;

  if v_turn_state.active_player_id <> auth.uid() then
    v_reason := 'Only the active player can declare attackers';
  elsif v_turn_state.step <> 'declare_attackers' then
    v_reason := 'Attackers can only be declared during Declare Attackers Step';
  end if;

  return jsonb_build_object(
    'can_declare_attackers',
    v_reason is null,
    'reason',
    v_reason,
    'active_player_id',
    v_turn_state.active_player_id,
    'current_player_id',
    auth.uid(),
    'turn_number',
    v_turn_state.turn_number,
    'phase',
    v_turn_state.phase,
    'step',
    v_turn_state.step
  );
end;
$$;

grant execute on function public.get_combat_action_state(uuid) to authenticated;
