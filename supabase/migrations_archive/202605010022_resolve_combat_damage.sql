alter table public.cards
add column if not exists power integer;

alter table public.cards
add column if not exists toughness integer;

alter table public.game_combat_assignments
add column if not exists damage_resolved boolean not null default false;

create or replace function public.resolve_combat_damage(
  p_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_required_player_id uuid;
  v_assignment record;
  v_damage integer;
  v_total_damage integer := 0;
  v_resolved_count integer := 0;
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
    raise exception 'Cannot resolve combat damage in a finished game session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if v_turn_state.step <> 'combat_damage' then
    raise exception 'Combat damage can only be resolved during Combat Damage Step';
  end if;

  v_required_player_id := coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id);

  if v_required_player_id <> auth.uid() then
    raise exception 'Only the priority player can resolve combat damage';
  end if;

  for v_assignment in
    select
      combat.id,
      combat.defending_player_id,
      combat.blocker_card_id,
      coalesce(
        case
          when attacker_card.power::text ~ '^[0-9]+$' then attacker_card.power
          else 0
        end,
        0
      ) as attacker_power
    from public.game_combat_assignments combat
    join public.game_cards attacker_instance
      on attacker_instance.id = combat.attacker_card_id
    left join public.cards attacker_card
      on attacker_card.id = attacker_instance.card_id
    where combat.session_id = p_session_id
      and combat.turn_number = v_turn_state.turn_number
      and combat.damage_resolved = false
    order by combat.created_at
    for update of combat
  loop
    v_damage := greatest(0, v_assignment.attacker_power);

    if v_assignment.blocker_card_id is null and v_damage > 0 then
      update public.game_session_players
      set life_total = greatest(0, life_total - v_damage)
      where session_id = p_session_id
        and player_id = v_assignment.defending_player_id;

      v_total_damage := v_total_damage + v_damage;
    end if;

    update public.game_combat_assignments
    set damage_resolved = true
    where id = v_assignment.id;

    v_resolved_count := v_resolved_count + 1;
  end loop;

  return jsonb_build_object(
    'assignments_resolved',
    v_resolved_count,
    'total_damage',
    v_total_damage
  );
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
  v_damage_reason text;
  v_blockable_attackers_count integer := 0;
  v_unresolved_combat_count integer := 0;
begin
  if auth.uid() is null then
    return jsonb_build_object(
      'can_declare_attackers', false,
      'can_declare_blockers', false,
      'can_resolve_combat_damage', false,
      'reason', 'Authentication required',
      'attack_reason', 'Authentication required',
      'block_reason', 'Authentication required',
      'damage_reason', 'Authentication required'
    );
  end if;

  v_is_session_player := public.is_session_player(p_session_id, auth.uid());

  if not v_is_session_player then
    return jsonb_build_object(
      'can_declare_attackers', false,
      'can_declare_blockers', false,
      'can_resolve_combat_damage', false,
      'reason', 'Current user is not a player in this session',
      'attack_reason', 'Current user is not a player in this session',
      'block_reason', 'Current user is not a player in this session',
      'damage_reason', 'Current user is not a player in this session',
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
      'can_resolve_combat_damage', false,
      'reason', 'Turn state not found',
      'attack_reason', 'Turn state not found',
      'block_reason', 'Turn state not found',
      'damage_reason', 'Turn state not found',
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

  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    v_block_reason := 'Only the priority player can declare blockers';
  elsif v_turn_state.step <> 'declare_blockers' then
    v_block_reason := 'Blockers can only be declared during Declare Blockers Step';
  elsif v_blockable_attackers_count = 0 then
    v_block_reason := 'No attackers are attacking you';
  end if;

  select count(*)
  into v_unresolved_combat_count
  from public.game_combat_assignments
  where session_id = p_session_id
    and turn_number = v_turn_state.turn_number
    and damage_resolved = false;

  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    v_damage_reason := 'Only the priority player can resolve combat damage';
  elsif v_turn_state.step <> 'combat_damage' then
    v_damage_reason := 'Combat damage can only be resolved during Combat Damage Step';
  elsif v_unresolved_combat_count = 0 then
    v_damage_reason := 'No unresolved combat damage';
  end if;

  return jsonb_build_object(
    'can_declare_attackers',
    v_attack_reason is null,
    'can_declare_blockers',
    v_block_reason is null,
    'can_resolve_combat_damage',
    v_damage_reason is null,
    'reason',
    coalesce(v_attack_reason, v_block_reason, v_damage_reason),
    'attack_reason',
    v_attack_reason,
    'block_reason',
    v_block_reason,
    'damage_reason',
    v_damage_reason,
    'blockable_attackers_count',
    v_blockable_attackers_count,
    'unresolved_combat_count',
    v_unresolved_combat_count,
    'active_player_id',
    v_turn_state.active_player_id,
    'priority_player_id',
    coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id),
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

grant execute on function public.resolve_combat_damage(uuid) to authenticated;
grant execute on function public.get_combat_action_state(uuid) to authenticated;
