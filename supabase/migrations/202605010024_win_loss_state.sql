alter table public.game_sessions
add column if not exists winner_player_id uuid;

create or replace function public.maybe_finish_game_session(
  p_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alive_count integer;
  v_total_players integer;
  v_winner_player_id uuid;
  v_session_status text;
begin
  select status
  into v_session_status
  from public.game_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'Game session not found';
  end if;

  if v_session_status = 'finished' then
    return jsonb_build_object(
      'finished', true,
      'winner_player_id', (
        select winner_player_id
        from public.game_sessions
        where id = p_session_id
      )
    );
  end if;

  select
    count(*) filter (where life_total > 0),
    count(*)
  into v_alive_count, v_total_players
  from public.game_session_players
  where session_id = p_session_id;

  if v_total_players < 2 then
    return jsonb_build_object('finished', false, 'winner_player_id', null);
  end if;

  if v_alive_count = 1 then
    select player_id
    into v_winner_player_id
    from public.game_session_players
    where session_id = p_session_id
      and life_total > 0
    limit 1;

    update public.game_sessions
    set
      status = 'finished',
      finished_at = coalesce(finished_at, now()),
      winner_player_id = v_winner_player_id
    where id = p_session_id;

    return jsonb_build_object(
      'finished', true,
      'winner_player_id', v_winner_player_id
    );
  end if;

  if v_alive_count = 0 then
    update public.game_sessions
    set
      status = 'finished',
      finished_at = coalesce(finished_at, now()),
      winner_player_id = null
    where id = p_session_id;

    return jsonb_build_object('finished', true, 'winner_player_id', null);
  end if;

  return jsonb_build_object('finished', false, 'winner_player_id', null);
end;
$$;

create or replace function public.adjust_player_life(
  p_session_id uuid,
  p_target_player_id uuid,
  p_delta integer
)
returns public.game_session_players
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_player public.game_session_players;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_delta = 0 then
    raise exception 'Life total delta cannot be zero';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if not public.is_session_player(p_session_id, p_target_player_id) then
    raise exception 'Target player is not a player in this session';
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
    raise exception 'Cannot change life totals in a finished game session';
  end if;

  update public.game_session_players
  set life_total = greatest(0, life_total + p_delta)
  where session_id = p_session_id
    and player_id = p_target_player_id
  returning * into v_player;

  if not found then
    raise exception 'Target player not found';
  end if;

  perform public.maybe_finish_game_session(p_session_id);

  return v_player;
end;
$$;

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
  v_finish_state jsonb;
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
        attacker_card.power,
        case
          when attacker_card.power_toughness ~ '^[0-9]+/[0-9]+$'
            then split_part(attacker_card.power_toughness, '/', 1)::integer
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

  v_finish_state := public.maybe_finish_game_session(p_session_id);

  return jsonb_build_object(
    'assignments_resolved',
    v_resolved_count,
    'total_damage',
    v_total_damage,
    'finished',
    coalesce((v_finish_state ->> 'finished')::boolean, false),
    'winner_player_id',
    v_finish_state ->> 'winner_player_id'
  );
end;
$$;

create or replace function public.finish_game_session(
  p_session_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  update public.game_sessions
  set
    status = 'finished',
    finished_at = coalesce(finished_at, now()),
    winner_player_id = null
  where id = p_session_id
    and created_by = auth.uid()
    and status <> 'finished';

  if not found then
    raise exception 'Game session not found, already finished, or not created by current user';
  end if;

  return true;
end;
$$;

grant execute on function public.maybe_finish_game_session(uuid) to authenticated;
grant execute on function public.adjust_player_life(uuid, uuid, integer) to authenticated;
grant execute on function public.resolve_combat_damage(uuid) to authenticated;
grant execute on function public.finish_game_session(uuid) to authenticated;
