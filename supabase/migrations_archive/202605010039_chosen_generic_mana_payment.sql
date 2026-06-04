drop function if exists public.pay_mana_cost(uuid, uuid, text);

create or replace function public.pay_mana_cost(
  p_session_id uuid,
  p_player_id uuid,
  p_mana_cost text,
  p_generic_payment jsonb default null
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
  v_clean_cost text;
  v_symbol text;
  v_generic_cost integer := 0;
  v_available_generic integer := 0;
  v_declared_generic_payment integer := 0;
  v_pay_amount integer;
  v_color text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_player_id <> auth.uid() then
    raise exception 'Cannot pay mana for another player';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if p_mana_cost is null or btrim(p_mana_cost) = '' then
    return v_empty_pool;
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

  v_new_pool := v_current_pool;
  v_clean_cost := upper(regexp_replace(p_mana_cost, '[{}\s]', '', 'g'));

  for v_symbol in
    select token[1]
    from regexp_matches(v_clean_cost, '([0-9]+|[WUBRGC])', 'g') as token
  loop
    if v_symbol ~ '^[0-9]+$' then
      v_generic_cost := v_generic_cost + v_symbol::integer;
    else
      v_pay_amount := coalesce((v_new_pool ->> v_symbol)::integer, 0);

      if v_pay_amount <= 0 then
        raise exception 'Not enough % mana to pay %', v_symbol, p_mana_cost;
      end if;

      v_new_pool := v_new_pool || jsonb_build_object(v_symbol, v_pay_amount - 1);
    end if;
  end loop;

  if v_generic_cost > 0 then
    select sum(coalesce((v_new_pool ->> color_symbol)::integer, 0))
    into v_available_generic
    from unnest(array['C', 'W', 'U', 'B', 'R', 'G']) as color_symbol;

    if coalesce(v_available_generic, 0) < v_generic_cost then
      raise exception 'Not enough mana to pay generic cost % for %', v_generic_cost, p_mana_cost;
    end if;

    if p_generic_payment is not null and p_generic_payment <> 'null'::jsonb then
      foreach v_color in array array['C', 'W', 'U', 'B', 'R', 'G']
      loop
        v_pay_amount := coalesce((p_generic_payment ->> v_color)::integer, 0);

        if v_pay_amount < 0 then
          raise exception 'Generic mana payment cannot be negative';
        end if;

        v_declared_generic_payment := v_declared_generic_payment + v_pay_amount;
      end loop;

      if v_declared_generic_payment <> v_generic_cost then
        raise exception 'Generic mana payment must total %, got %', v_generic_cost, v_declared_generic_payment;
      end if;

      foreach v_color in array array['C', 'W', 'U', 'B', 'R', 'G']
      loop
        v_pay_amount := coalesce((p_generic_payment ->> v_color)::integer, 0);

        if v_pay_amount > coalesce((v_new_pool ->> v_color)::integer, 0) then
          raise exception 'Not enough % mana to pay chosen generic cost', v_color;
        end if;

        if v_pay_amount > 0 then
          v_new_pool := v_new_pool || jsonb_build_object(
            v_color,
            coalesce((v_new_pool ->> v_color)::integer, 0) - v_pay_amount
          );
        end if;
      end loop;
    else
      foreach v_color in array array['C', 'W', 'U', 'B', 'R', 'G']
      loop
        exit when v_generic_cost <= 0;

        v_pay_amount := least(coalesce((v_new_pool ->> v_color)::integer, 0), v_generic_cost);

        if v_pay_amount > 0 then
          v_new_pool := v_new_pool || jsonb_build_object(
            v_color,
            coalesce((v_new_pool ->> v_color)::integer, 0) - v_pay_amount
          );
          v_generic_cost := v_generic_cost - v_pay_amount;
        end if;
      end loop;
    end if;
  end if;

  update public.game_players
  set mana_pool = v_new_pool
  where session_id = p_session_id
    and player_id = p_player_id;

  return v_new_pool;
end;
$$;

drop function if exists public.cast_card_from_hand(uuid, uuid);

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
  v_next_battlefield_position integer;
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
    if coalesce(v_turn_state.lands_played_this_turn, 0) >= 1 then
      raise exception 'You have already played a land this turn';
    end if;

    update public.game_turn_state
    set lands_played_this_turn = lands_played_this_turn + 1
    where session_id = p_session_id;
  else
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_card_mana_cost, p_generic_payment);
  end if;

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
end;
$$;

create or replace function public.put_action_on_stack(
  p_session_id uuid,
  p_action_type text,
  p_payload jsonb,
  p_source_card_id uuid default null
)
returns public.game_stack_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_target_player_id uuid;
  v_amount integer;
  v_action_timing text;
  v_source_type_line text;
  v_source_zone text;
  v_source_mana_cost text;
  v_generic_payment jsonb;
  v_pending_stack_count integer;
  v_next_graveyard_position integer;
  v_next_position integer;
  v_stack_item public.game_stack_items;
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
    raise exception 'Cannot put actions on the stack in a finished game session';
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
    raise exception 'Only the priority player can put actions on the stack';
  end if;

  if p_action_type <> 'deal_damage_player' then
    raise exception 'Unsupported stack action type: %', p_action_type;
  end if;

  if p_source_card_id is not null then
    select cards.type_line, cards.mana_cost, game_cards.zone
    into v_source_type_line, v_source_mana_cost, v_source_zone
    from public.game_cards
    join public.cards
      on cards.id = game_cards.card_id
    where game_cards.id = p_source_card_id
      and game_cards.session_id = p_session_id
      and game_cards.owner_id = auth.uid();

    if not found then
      raise exception 'Source card not found or not owned by current user';
    end if;
  end if;

  v_action_timing := lower(nullif(p_payload ->> 'timing', ''));

  if v_action_timing is null then
    if v_source_type_line ilike '%instant%' then
      v_action_timing := 'instant';
    elsif v_source_type_line ilike '%sorcery%' then
      v_action_timing := 'sorcery';
    else
      raise exception 'Action timing is required for non-Instant and non-Sorcery sources';
    end if;
  end if;

  if v_action_timing not in ('instant', 'sorcery') then
    raise exception 'Unsupported action timing: %', v_action_timing;
  end if;

  if v_action_timing = 'sorcery' then
    if v_turn_state.active_player_id <> auth.uid() then
      raise exception 'Sorcery actions can only be used by the active player';
    end if;

    if v_turn_state.step not in ('precombat_main', 'postcombat_main') then
      raise exception 'Sorcery actions can only be used during a main phase';
    end if;

    select count(*)
    into v_pending_stack_count
    from public.game_stack_items
    where session_id = p_session_id
      and status = 'pending';

    if v_pending_stack_count > 0 then
      raise exception 'Sorcery actions can only be used while the stack is empty';
    end if;
  end if;

  v_target_player_id := nullif(p_payload ->> 'target_player_id', '')::uuid;
  v_amount := coalesce((p_payload ->> 'amount')::integer, 0);
  v_generic_payment := p_payload -> 'generic_payment';

  if v_target_player_id is null then
    raise exception 'target_player_id is required';
  end if;

  if v_amount <= 0 then
    raise exception 'amount must be positive';
  end if;

  if not public.is_session_player(p_session_id, v_target_player_id) then
    raise exception 'Target player is not a player in this session';
  end if;

  if p_source_card_id is not null and v_source_zone = 'hand' then
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_source_mana_cost, v_generic_payment);
  end if;

  select coalesce(max(position), -1) + 1
  into v_next_position
  from public.game_stack_items
  where session_id = p_session_id;

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
    p_source_card_id,
    p_action_type,
    jsonb_build_object(
      'target_player_id', v_target_player_id,
      'amount', v_amount,
      'timing', v_action_timing
    ),
    v_next_position
  )
  returning * into v_stack_item;

  if p_source_card_id is not null
    and v_source_zone = 'hand'
    and (
      v_source_type_line ilike '%instant%'
      or v_source_type_line ilike '%sorcery%'
    )
  then
    select coalesce(max(zone_position), -1) + 1
    into v_next_graveyard_position
    from public.game_cards
    where session_id = p_session_id
      and owner_id = auth.uid()
      and zone = 'graveyard';

    update public.game_cards
    set
      zone = 'graveyard',
      zone_position = v_next_graveyard_position,
      is_tapped = false,
      damage_marked = 0
    where id = p_source_card_id;
  end if;

  update public.game_turn_state
  set
    priority_player_id = active_player_id,
    priority_cycle_started_by = null,
    priority_pass_count = 0
  where session_id = p_session_id;

  return v_stack_item;
end;
$$;

grant execute on function public.pay_mana_cost(uuid, uuid, text, jsonb) to authenticated;
grant execute on function public.cast_card_from_hand(uuid, uuid, jsonb) to authenticated;
grant execute on function public.put_action_on_stack(uuid, text, jsonb, uuid) to authenticated;
