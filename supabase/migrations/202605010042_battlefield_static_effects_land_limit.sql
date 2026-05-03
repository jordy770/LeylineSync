alter table public.game_continuous_effects
add column if not exists source_zone_required text;

alter table public.game_continuous_effects
drop constraint if exists game_continuous_effects_effect_type_check;

alter table public.game_continuous_effects
add constraint game_continuous_effects_effect_type_check
check (effect_type in ('mana_does_not_empty', 'additional_land_plays'));

alter table public.game_continuous_effects
drop constraint if exists game_continuous_effects_source_zone_required_check;

alter table public.game_continuous_effects
add constraint game_continuous_effects_source_zone_required_check
check (
  source_zone_required is null
  or source_zone_required in ('library', 'hand', 'stack', 'battlefield', 'graveyard', 'exile')
);

create or replace function public.get_land_play_limit(
  p_session_id uuid,
  p_player_id uuid
)
returns integer
language sql
security definer
set search_path = public
as $$
  select 1 + coalesce(sum(coalesce((effects.payload ->> 'amount')::integer, 0)), 0)::integer
  from public.game_continuous_effects effects
  left join public.game_cards source_card
    on source_card.id = effects.source_card_id
  where effects.session_id = p_session_id
    and effects.effect_type = 'additional_land_plays'
    and (effects.affected_player_id is null or effects.affected_player_id = p_player_id)
    and public.is_session_player(p_session_id, auth.uid())
    and public.is_session_player(p_session_id, p_player_id)
    and (
      effects.source_zone_required is null
      or source_card.zone = effects.source_zone_required
    );
$$;

create or replace function public.clear_mana_pool_for_step(
  p_session_id uuid,
  p_phase text,
  p_step text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empty_pool jsonb := jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0);
  v_player record;
  v_retained_colors text[];
  v_new_pool jsonb;
  v_color text;
  v_updated_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  for v_player in
    select
      player_id,
      coalesce(mana_pool, v_empty_pool) as mana_pool
    from public.game_players
    where session_id = p_session_id
    for update
  loop
    select coalesce(array_agg(distinct retained.color), '{}'::text[])
    into v_retained_colors
    from public.game_continuous_effects effects
    left join public.game_cards source_card
      on source_card.id = effects.source_card_id
    cross join lateral jsonb_array_elements_text(
      coalesce(effects.payload -> 'colors', '[]'::jsonb)
    ) as retained(color)
    where effects.session_id = p_session_id
      and effects.effect_type = 'mana_does_not_empty'
      and (effects.affected_player_id is null or effects.affected_player_id = v_player.player_id)
      and (
        effects.source_zone_required is null
        or source_card.zone = effects.source_zone_required
      );

    v_new_pool := v_empty_pool;

    foreach v_color in array array['W', 'U', 'B', 'R', 'G', 'C']
    loop
      if v_color = any(v_retained_colors) then
        v_new_pool := v_new_pool || jsonb_build_object(
          v_color,
          coalesce((v_player.mana_pool ->> v_color)::integer, 0)
        );
      end if;
    end loop;

    if v_new_pool <> v_player.mana_pool then
      update public.game_players
      set mana_pool = v_new_pool
      where session_id = p_session_id
        and player_id = v_player.player_id;

      v_updated_count := v_updated_count + 1;
    end if;
  end loop;

  return v_updated_count;
end;
$$;

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
  land_play_limit integer,
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
    public.get_land_play_limit(p_session_id, auth.uid()) as land_play_limit,
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

create or replace function public.cast_card_from_hand(
  p_session_id uuid,
  p_game_card_id uuid,
  p_generic_payment jsonb default null
)
returns public.game_cards
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_card public.game_cards;
  v_card_type_line text;
  v_card_mana_cost text;
  v_pending_stack_count integer := 0;
  v_land_play_limit integer := 1;
  v_next_battlefield_position integer;
  v_next_stack_position integer;
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
    raise exception 'Cannot cast cards in a finished game session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can cast cards';
  end if;

  select game_cards.*
  into v_card
  from public.game_cards
  join public.cards
    on cards.id = game_cards.card_id
  where game_cards.id = p_game_card_id
    and game_cards.session_id = p_session_id
    and game_cards.owner_id = auth.uid()
    and game_cards.zone = 'hand'
  for update of game_cards;

  if not found then
    raise exception 'Card not found in hand or not owned by current user';
  end if;

  select cards.type_line, cards.mana_cost
  into v_card_type_line, v_card_mana_cost
  from public.cards
  where cards.id = v_card.card_id;

  if coalesce(v_card_type_line, '') ilike '%instant%'
    or coalesce(v_card_type_line, '') ilike '%sorcery%'
  then
    raise exception 'Use this spell action to cast instant and sorcery cards';
  end if;

  if v_turn_state.active_player_id <> auth.uid() then
    raise exception 'Cards can only be played by the active player in this first implementation';
  end if;

  if v_turn_state.step not in ('precombat_main', 'postcombat_main') then
    raise exception 'Cards can only be played during a main phase';
  end if;

  select count(*)
  into v_pending_stack_count
  from public.game_stack_items
  where session_id = p_session_id
    and status = 'pending';

  if v_pending_stack_count > 0 then
    raise exception 'Cards can only be played while the stack is empty';
  end if;

  if coalesce(v_card_type_line, '') ilike '%land%' then
    v_land_play_limit := public.get_land_play_limit(p_session_id, auth.uid());

    if coalesce(v_turn_state.lands_played_this_turn, 0) >= v_land_play_limit then
      raise exception 'You have already used all land plays this turn';
    end if;

    update public.game_turn_state
    set lands_played_this_turn = lands_played_this_turn + 1
    where session_id = p_session_id;

    select coalesce(max(zone_position), -1) + 1
    into v_next_battlefield_position
    from public.game_cards
    where session_id = p_session_id
      and owner_id = auth.uid()
      and zone = 'battlefield';

    update public.game_cards
    set
      zone = 'battlefield',
      zone_position = v_next_battlefield_position,
      is_tapped = false,
      damage_marked = 0
    where id = p_game_card_id
    returning * into v_card;

    return v_card;
  end if;

  perform public.pay_mana_cost(p_session_id, auth.uid(), v_card_mana_cost, p_generic_payment);

  select coalesce(max(position), -1) + 1
  into v_next_stack_position
  from public.game_stack_items
  where session_id = p_session_id;

  update public.game_cards
  set
    zone = 'stack',
    zone_position = v_next_stack_position,
    is_tapped = false,
    damage_marked = 0
  where id = p_game_card_id
  returning * into v_card;

  insert into public.game_stack_items (
    session_id,
    controller_player_id,
    source_card_id,
    action_type,
    payload,
    position
  )
  values (
    p_session_id,
    auth.uid(),
    p_game_card_id,
    'cast_permanent',
    jsonb_build_object(
      'timing', 'sorcery',
      'card_id', v_card.card_id,
      'type_line', v_card_type_line
    ),
    v_next_stack_position
  );

  update public.game_turn_state
  set
    priority_player_id = active_player_id,
    priority_cycle_started_by = null,
    priority_pass_count = 0
  where session_id = p_session_id;

  return v_card;
end;
$$;

grant execute on function public.get_land_play_limit(uuid, uuid) to authenticated;
grant execute on function public.get_turn_state(uuid) to authenticated;
grant execute on function public.clear_mana_pool_for_step(uuid, text, text) to authenticated;
grant execute on function public.cast_card_from_hand(uuid, uuid, jsonb) to authenticated;
