create or replace function public.declare_blocker(
  p_session_id uuid,
  p_blocker_card_id uuid,
  p_attacker_card_id uuid
)
returns public.game_combat_assignments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_assignment public.game_combat_assignments;
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
    raise exception 'Cannot declare blockers in a finished game session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if v_turn_state.step <> 'declare_blockers' then
    raise exception 'Blockers can only be declared during Declare Blockers Step';
  end if;

  select *
  into v_assignment
  from public.game_combat_assignments
  where session_id = p_session_id
    and turn_number = v_turn_state.turn_number
    and attacker_card_id = p_attacker_card_id
  for update;

  if not found then
    raise exception 'Attacker assignment not found';
  end if;

  if v_assignment.defending_player_id <> auth.uid() then
    raise exception 'Only the defending player can block this attacker';
  end if;

  if v_assignment.blocker_card_id is not null then
    raise exception 'This attacker is already blocked';
  end if;

  perform 1
  from public.game_combat_assignments
  where session_id = p_session_id
    and turn_number = v_turn_state.turn_number
    and blocker_card_id = p_blocker_card_id;

  if found then
    raise exception 'This blocker is already assigned';
  end if;

  update public.game_cards
  set is_tapped = true
  where id = p_blocker_card_id
    and session_id = p_session_id
    and owner_id = auth.uid()
    and zone = 'battlefield'
    and is_tapped = false;

  if not found then
    raise exception 'Blocker card not found, not on battlefield, not owned by defending player, or already tapped';
  end if;

  update public.game_combat_assignments
  set blocker_card_id = p_blocker_card_id
  where id = v_assignment.id
  returning * into v_assignment;

  return v_assignment;
end;
$$;

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
  v_attack_reason text;
  v_block_reason text;
  v_blockable_attackers_count integer := 0;
begin
  if auth.uid() is null then
    return jsonb_build_object(
      'can_declare_attackers', false,
      'can_declare_blockers', false,
      'reason', 'Authentication required',
      'attack_reason', 'Authentication required',
      'block_reason', 'Authentication required'
    );
  end if;

  v_is_session_player := public.is_session_player(p_session_id, auth.uid());

  if not v_is_session_player then
    return jsonb_build_object(
      'can_declare_attackers', false,
      'can_declare_blockers', false,
      'reason', 'Current user is not a player in this session',
      'attack_reason', 'Current user is not a player in this session',
      'block_reason', 'Current user is not a player in this session',
      'current_player_id', auth.uid()
    );
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = p_session_id;

  if not found then
    return jsonb_build_object(
      'can_declare_attackers', false,
      'can_declare_blockers', false,
      'reason', 'Turn state not found',
      'attack_reason', 'Turn state not found',
      'block_reason', 'Turn state not found',
      'current_player_id', auth.uid()
    );
  end if;

  if v_turn_state.active_player_id <> auth.uid() then
    v_attack_reason := 'Only the active player can declare attackers';
  elsif v_turn_state.step <> 'declare_attackers' then
    v_attack_reason := 'Attackers can only be declared during Declare Attackers Step';
  end if;

  select count(*)
  into v_blockable_attackers_count
  from public.game_combat_assignments
  where session_id = p_session_id
    and turn_number = v_turn_state.turn_number
    and defending_player_id = auth.uid()
    and blocker_card_id is null;

  if v_turn_state.step <> 'declare_blockers' then
    v_block_reason := 'Blockers can only be declared during Declare Blockers Step';
  elsif v_blockable_attackers_count = 0 then
    v_block_reason := 'No attackers are attacking you';
  end if;

  return jsonb_build_object(
    'can_declare_attackers',
    v_attack_reason is null,
    'can_declare_blockers',
    v_block_reason is null,
    'reason',
    coalesce(v_attack_reason, v_block_reason),
    'attack_reason',
    v_attack_reason,
    'block_reason',
    v_block_reason,
    'blockable_attackers_count',
    v_blockable_attackers_count,
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

grant execute on function public.declare_blocker(uuid, uuid, uuid) to authenticated;
grant execute on function public.get_combat_action_state(uuid) to authenticated;
