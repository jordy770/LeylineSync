create or replace function public.dev_add_mana(
  p_session_id uuid,
  p_player_id uuid,
  p_color text,
  p_amount integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empty_pool jsonb := jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0);
  v_current_pool jsonb;
  v_new_pool jsonb;
  v_current_amount integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if not public.is_session_player(p_session_id, p_player_id) then
    raise exception 'Target player is not a player in this session';
  end if;

  if p_color not in ('W', 'U', 'B', 'R', 'G', 'C') then
    raise exception 'Invalid mana color: %', p_color;
  end if;

  if p_amount = 0 then
    raise exception 'Mana amount cannot be zero';
  end if;

  insert into public.game_players (session_id, player_id, mana_pool)
  values (p_session_id, p_player_id, v_empty_pool)
  on conflict (session_id, player_id) do nothing;

  select coalesce(mana_pool, v_empty_pool)
  into v_current_pool
  from public.game_players
  where session_id = p_session_id
    and player_id = p_player_id
  for update;

  v_current_amount := coalesce((v_current_pool ->> p_color)::integer, 0);
  v_new_pool := v_current_pool || jsonb_build_object(p_color, greatest(0, v_current_amount + p_amount));

  update public.game_players
  set mana_pool = v_new_pool
  where session_id = p_session_id
    and player_id = p_player_id;

  return v_new_pool;
end;
$$;

create or replace function public.dev_spawn_card(
  p_session_id uuid,
  p_player_id uuid,
  p_card_id uuid,
  p_zone text default 'hand',
  p_tapped boolean default false
)
returns public.game_cards
language plpgsql
security definer
set search_path = public
as $$
declare
  v_turn_number integer;
  v_next_zone_position integer;
  v_card public.game_cards;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if not public.is_session_player(p_session_id, p_player_id) then
    raise exception 'Target player is not a player in this session';
  end if;

  if p_zone not in ('library', 'hand', 'stack', 'battlefield', 'graveyard', 'exile') then
    raise exception 'Invalid zone: %', p_zone;
  end if;

  perform 1
  from public.cards
  where id = p_card_id;

  if not found then
    raise exception 'Card not found';
  end if;

  select turn_number
  into v_turn_number
  from public.game_turn_state
  where session_id = p_session_id;

  select coalesce(max(zone_position), -1) + 1
  into v_next_zone_position
  from public.game_cards
  where session_id = p_session_id
    and owner_id = p_player_id
    and zone = p_zone;

  insert into public.game_cards (
    session_id,
    card_id,
    owner_id,
    controller_player_id,
    zone,
    zone_position,
    is_tapped,
    damage_marked,
    position_x,
    position_y,
    entered_battlefield_turn_number
  )
  values (
    p_session_id,
    p_card_id,
    p_player_id,
    p_player_id,
    p_zone,
    v_next_zone_position,
    p_tapped,
    0,
    0,
    0,
    case when p_zone = 'battlefield' then coalesce(v_turn_number, 0) else null end
  )
  returning * into v_card;

  if p_zone = 'battlefield' then
    perform public.rebuild_scripted_continuous_effects(p_session_id);
  end if;

  return v_card;
end;
$$;

create or replace function public.dev_set_turn_state(
  p_session_id uuid,
  p_phase text,
  p_step text,
  p_active_player_id uuid default null,
  p_priority_player_id uuid default null,
  p_turn_number integer default null
)
returns public.game_turn_state
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state public.game_turn_state;
  v_active_player_id uuid;
  v_priority_player_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if p_phase not in ('beginning', 'main_1', 'combat', 'main_2', 'ending') then
    raise exception 'Invalid phase: %', p_phase;
  end if;

  if p_step not in (
    'untap',
    'upkeep',
    'draw',
    'precombat_main',
    'beginning_of_combat',
    'declare_attackers',
    'declare_blockers',
    'combat_damage',
    'end_of_combat',
    'postcombat_main',
    'end',
    'cleanup'
  ) then
    raise exception 'Invalid step: %', p_step;
  end if;

  select *
  into v_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  v_active_player_id := coalesce(p_active_player_id, v_state.active_player_id);
  v_priority_player_id := coalesce(p_priority_player_id, v_active_player_id);

  if not public.is_session_player(p_session_id, v_active_player_id) then
    raise exception 'Active player is not a player in this session';
  end if;

  if not public.is_session_player(p_session_id, v_priority_player_id) then
    raise exception 'Priority player is not a player in this session';
  end if;

  update public.game_turn_state
  set
    active_player_id = v_active_player_id,
    priority_player_id = v_priority_player_id,
    priority_cycle_started_by = null,
    priority_pass_count = 0,
    turn_number = coalesce(p_turn_number, turn_number),
    phase = p_phase,
    step = p_step
  where session_id = p_session_id
  returning * into v_state;

  return v_state;
end;
$$;

grant execute on function public.dev_add_mana(uuid, uuid, text, integer) to authenticated;
grant execute on function public.dev_spawn_card(uuid, uuid, uuid, text, boolean) to authenticated;
grant execute on function public.dev_set_turn_state(uuid, text, text, uuid, uuid, integer) to authenticated;
