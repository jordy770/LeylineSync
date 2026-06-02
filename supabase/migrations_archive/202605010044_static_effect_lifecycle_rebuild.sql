alter table public.game_cards
add column if not exists controller_player_id uuid;

alter table public.game_cards
add column if not exists copied_script jsonb;

alter table public.game_cards
add column if not exists static_effects_suppressed boolean not null default false;

update public.game_cards
set controller_player_id = owner_id
where controller_player_id is null;

create or replace function public.register_card_continuous_effects(
  p_session_id uuid,
  p_source_card_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source_card public.game_cards;
  v_script jsonb;
  v_effect jsonb;
  v_effect_type text;
  v_affected text;
  v_affected_player_id uuid;
  v_source_zone_required text;
  v_payload jsonb;
  v_registered_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select game_cards.*
  into v_source_card
  from public.game_cards
  where game_cards.id = p_source_card_id
    and game_cards.session_id = p_session_id;

  if not found then
    raise exception 'Source card not found';
  end if;

  delete from public.game_continuous_effects
  where session_id = p_session_id
    and source_card_id = p_source_card_id
    and payload ->> 'registered_from_card_script' = 'true';

  if v_source_card.zone <> 'battlefield' or v_source_card.static_effects_suppressed then
    return 0;
  end if;

  select coalesce(v_source_card.copied_script, cards.script)
  into v_script
  from public.cards
  where cards.id = v_source_card.card_id;

  for v_effect in
    select value
    from jsonb_array_elements(coalesce(v_script -> 'continuous_effects', '[]'::jsonb))
  loop
    v_effect_type := coalesce(v_effect ->> 'effect_type', v_effect ->> 'type');

    if v_effect_type not in ('mana_does_not_empty', 'additional_land_plays') then
      raise exception 'Unsupported continuous effect type: %', v_effect_type;
    end if;

    v_affected := coalesce(v_effect ->> 'affected', 'controller');

    if v_affected in ('all', 'all_players') then
      v_affected_player_id := null;
    elsif v_affected in ('controller', 'self') then
      v_affected_player_id := coalesce(v_source_card.controller_player_id, v_source_card.owner_id);
    else
      raise exception 'Unsupported continuous effect affected value: %', v_affected;
    end if;

    v_source_zone_required := coalesce(v_effect ->> 'source_zone_required', 'battlefield');

    if v_source_zone_required not in ('library', 'hand', 'stack', 'battlefield', 'graveyard', 'exile') then
      raise exception 'Unsupported source zone requirement: %', v_source_zone_required;
    end if;

    if v_effect_type = 'additional_land_plays' then
      v_payload := jsonb_build_object(
        'amount',
        coalesce((v_effect ->> 'amount')::integer, 1)
      );
    elsif v_effect_type = 'mana_does_not_empty' then
      v_payload := jsonb_build_object(
        'colors',
        coalesce(v_effect -> 'colors', '[]'::jsonb)
      );
    end if;

    v_payload := coalesce(v_effect -> 'payload', v_payload)
      || jsonb_build_object('registered_from_card_script', true);

    insert into public.game_continuous_effects (
      session_id,
      source_card_id,
      affected_player_id,
      effect_type,
      payload,
      source_zone_required,
      expires_at_turn_number,
      expires_at_phase,
      expires_at_step
    )
    values (
      p_session_id,
      p_source_card_id,
      v_affected_player_id,
      v_effect_type,
      v_payload,
      v_source_zone_required,
      nullif(v_effect ->> 'expires_at_turn_number', '')::integer,
      nullif(v_effect ->> 'expires_at_phase', ''),
      nullif(v_effect ->> 'expires_at_step', '')
    );

    v_registered_count := v_registered_count + 1;
  end loop;

  return v_registered_count;
end;
$$;

create or replace function public.rebuild_scripted_continuous_effects(
  p_session_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card record;
  v_registered_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  delete from public.game_continuous_effects
  where session_id = p_session_id
    and payload ->> 'registered_from_card_script' = 'true';

  for v_card in
    select game_cards.id
    from public.game_cards
    left join public.cards
      on cards.id = game_cards.card_id
    where game_cards.session_id = p_session_id
      and game_cards.zone = 'battlefield'
      and game_cards.static_effects_suppressed = false
      and (
        coalesce(game_cards.copied_script ? 'continuous_effects', false)
        or coalesce(cards.script ? 'continuous_effects', false)
      )
  loop
    v_registered_count := v_registered_count
      + public.register_card_continuous_effects(p_session_id, v_card.id);
  end loop;

  return v_registered_count;
end;
$$;

create or replace function public.set_card_controller(
  p_game_card_id uuid,
  p_controller_player_id uuid
)
returns public.game_cards
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card public.game_cards;
  v_turn_state public.game_turn_state;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select *
  into v_card
  from public.game_cards
  where id = p_game_card_id
  for update;

  if not found then
    raise exception 'Card not found';
  end if;

  if not public.is_session_player(v_card.session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = v_card.session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can change card controller';
  end if;

  if not public.is_session_player(v_card.session_id, p_controller_player_id) then
    raise exception 'Controller is not a player in this session';
  end if;

  update public.game_cards
  set controller_player_id = p_controller_player_id
  where id = p_game_card_id
  returning * into v_card;

  perform public.rebuild_scripted_continuous_effects(v_card.session_id);

  return v_card;
end;
$$;

create or replace function public.set_card_copied_script(
  p_game_card_id uuid,
  p_copied_script jsonb
)
returns public.game_cards
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card public.game_cards;
  v_turn_state public.game_turn_state;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select *
  into v_card
  from public.game_cards
  where id = p_game_card_id
  for update;

  if not found then
    raise exception 'Card not found';
  end if;

  if not public.is_session_player(v_card.session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = v_card.session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can change copied script';
  end if;

  update public.game_cards
  set copied_script = p_copied_script
  where id = p_game_card_id
  returning * into v_card;

  perform public.rebuild_scripted_continuous_effects(v_card.session_id);

  return v_card;
end;
$$;

create or replace function public.set_card_static_effects_suppressed(
  p_game_card_id uuid,
  p_suppressed boolean
)
returns public.game_cards
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card public.game_cards;
  v_turn_state public.game_turn_state;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select *
  into v_card
  from public.game_cards
  where id = p_game_card_id
  for update;

  if not found then
    raise exception 'Card not found';
  end if;

  if not public.is_session_player(v_card.session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = v_card.session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can suppress static effects';
  end if;

  update public.game_cards
  set static_effects_suppressed = p_suppressed
  where id = p_game_card_id
  returning * into v_card;

  perform public.rebuild_scripted_continuous_effects(v_card.session_id);

  return v_card;
end;
$$;

create or replace function public.move_card_to_zone(
  p_game_card_id uuid,
  p_zone text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
begin
  if p_zone not in ('library', 'hand', 'stack', 'battlefield', 'graveyard', 'exile') then
    raise exception 'Invalid zone: %', p_zone;
  end if;

  update public.game_cards
  set
    zone = p_zone,
    is_tapped = false
  where id = p_game_card_id
    and owner_id = auth.uid()
  returning session_id into v_session_id;

  if not found then
    raise exception 'Card not found or not owned by current user';
  end if;

  perform public.rebuild_scripted_continuous_effects(v_session_id);
end;
$$;

create or replace function public.resolve_top_of_stack(
  p_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_stack_item public.game_stack_items;
  v_target_player_id uuid;
  v_amount integer;
  v_next_battlefield_position integer;
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
    raise exception 'Cannot resolve stack in a finished game session';
  end if;

  select *
  into v_stack_item
  from public.game_stack_items
  where session_id = p_session_id
    and status = 'pending'
  order by position desc
  limit 1
  for update;

  if not found then
    raise exception 'Stack is empty';
  end if;

  if v_stack_item.action_type = 'deal_damage_player' then
    v_target_player_id := nullif(v_stack_item.payload ->> 'target_player_id', '')::uuid;
    v_amount := coalesce((v_stack_item.payload ->> 'amount')::integer, 0);

    if v_target_player_id is null or v_amount <= 0 then
      raise exception 'Invalid deal_damage_player payload';
    end if;

    update public.game_session_players
    set life_total = greatest(0, life_total - v_amount)
    where session_id = p_session_id
      and player_id = v_target_player_id;

    if not found then
      raise exception 'Target player not found';
    end if;
  elsif v_stack_item.action_type = 'cast_permanent' then
    if v_stack_item.source_card_id is null then
      raise exception 'Permanent spell has no source card';
    end if;

    select coalesce(max(zone_position), -1) + 1
    into v_next_battlefield_position
    from public.game_cards
    where session_id = p_session_id
      and owner_id = v_stack_item.controller_player_id
      and zone = 'battlefield';

    update public.game_cards
    set
      zone = 'battlefield',
      zone_position = v_next_battlefield_position,
      controller_player_id = coalesce(controller_player_id, owner_id),
      is_tapped = false,
      damage_marked = 0
    where id = v_stack_item.source_card_id
      and session_id = p_session_id
      and owner_id = v_stack_item.controller_player_id
      and zone = 'stack';

    if not found then
      raise exception 'Permanent spell source card not found on stack';
    end if;
  else
    raise exception 'Unsupported stack action type: %', v_stack_item.action_type;
  end if;

  update public.game_stack_items
  set
    status = 'resolved',
    resolved_at = now()
  where id = v_stack_item.id;

  perform public.rebuild_scripted_continuous_effects(p_session_id);

  update public.game_turn_state
  set
    priority_player_id = active_player_id,
    priority_cycle_started_by = null,
    priority_pass_count = 0
  where session_id = p_session_id;

  v_finish_state := public.maybe_finish_game_session(p_session_id);

  return jsonb_build_object(
    'resolved_stack_item_id',
    v_stack_item.id,
    'action_type',
    v_stack_item.action_type,
    'finished',
    coalesce((v_finish_state ->> 'finished')::boolean, false),
    'winner_player_id',
    v_finish_state ->> 'winner_player_id'
  );
end;
$$;

grant execute on function public.register_card_continuous_effects(uuid, uuid) to authenticated;
grant execute on function public.rebuild_scripted_continuous_effects(uuid) to authenticated;
grant execute on function public.set_card_controller(uuid, uuid) to authenticated;
grant execute on function public.set_card_copied_script(uuid, jsonb) to authenticated;
grant execute on function public.set_card_static_effects_suppressed(uuid, boolean) to authenticated;
grant execute on function public.move_card_to_zone(uuid, text) to authenticated;
grant execute on function public.resolve_top_of_stack(uuid) to authenticated;
