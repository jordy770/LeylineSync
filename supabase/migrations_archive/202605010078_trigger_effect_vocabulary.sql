-- Widen the triggered-ability effect vocabulary, and refactor resolution so
-- future effect types only touch one small helper.
--
--   * apply_triggered_ability_effects(session, controller, source_card, effects)
--     holds the effect loop. resolve_top_of_stack's 'triggered_ability' branch
--     now just calls it. Adding an effect type = edit this one function.
--   * New effect types:
--       create_token { token: <token card name>, count: N }  -> controller makes N tokens
--       add_counters { amount: N }                            -> N +1/+1 counters on the source
--     (alongside the existing gain_life / lose_life / deal_damage / draw.)

create or replace function public.apply_triggered_ability_effects(
  p_session_id uuid,
  p_controller_id uuid,
  p_source_card_id uuid,
  p_effects jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_effect jsonb;
  v_eff_type text;
  v_eff_amount integer;
  v_recipient text;
  v_recipients uuid[];
  v_rid uuid;
  v_draw_i integer;
  v_lib_card uuid;
  v_next_hand_position integer;
  v_token_card_id uuid;
  v_token_count integer;
  v_turn_number integer;
  v_next_pos integer;
  v_new_token_id uuid;
  v_i integer;
begin
  for v_effect in
    select * from jsonb_array_elements(coalesce(p_effects, '[]'::jsonb))
  loop
    v_eff_type := lower(coalesce(v_effect ->> 'type', ''));
    v_eff_amount := coalesce((v_effect ->> 'amount')::integer, 0);
    v_recipient := lower(coalesce(v_effect ->> 'recipient', ''));

    if v_eff_type = 'gain_life' then
      if v_eff_amount > 0 and p_controller_id is not null then
        update public.game_session_players
        set life_total = life_total + v_eff_amount
        where session_id = p_session_id
          and player_id = p_controller_id;
      end if;

    elsif v_eff_type in ('lose_life', 'deal_damage') then
      if v_eff_amount > 0 then
        if v_recipient = 'controller' then
          v_recipients := array[p_controller_id];
        else
          select array_agg(player_id)
          into v_recipients
          from public.game_session_players
          where session_id = p_session_id
            and player_id is distinct from p_controller_id;
        end if;

        foreach v_rid in array coalesce(v_recipients, array[]::uuid[])
        loop
          update public.game_session_players
          set life_total = greatest(0, life_total - v_eff_amount)
          where session_id = p_session_id
            and player_id = v_rid;
        end loop;
      end if;

    elsif v_eff_type = 'draw' then
      if p_controller_id is not null then
        for v_draw_i in 1..greatest(1, v_eff_amount) loop
          select coalesce(max(zone_position), -1) + 1
          into v_next_hand_position
          from public.game_cards
          where session_id = p_session_id
            and owner_id = p_controller_id
            and zone = 'hand';

          select id
          into v_lib_card
          from public.game_cards
          where session_id = p_session_id
            and owner_id = p_controller_id
            and zone = 'library'
          order by zone_position asc, id asc
          limit 1
          for update skip locked;

          exit when v_lib_card is null;

          update public.game_cards
          set zone = 'hand', zone_position = v_next_hand_position, is_tapped = false
          where id = v_lib_card;
        end loop;
      end if;

    elsif v_eff_type = 'create_token' then
      v_token_count := greatest(1, coalesce((v_effect ->> 'count')::integer, 1));

      select id
      into v_token_card_id
      from public.cards
      where lower(name) = lower(coalesce(v_effect ->> 'token', ''))
        and is_token = true
      limit 1;

      if found and p_controller_id is not null then
        select turn_number
        into v_turn_number
        from public.game_turn_state
        where session_id = p_session_id;

        for v_i in 1..least(v_token_count, 20) loop
          select coalesce(max(zone_position), -1) + 1
          into v_next_pos
          from public.game_cards
          where session_id = p_session_id
            and owner_id = p_controller_id
            and zone = 'battlefield';

          insert into public.game_cards (
            session_id, card_id, owner_id, controller_player_id,
            zone, zone_position, is_tapped, damage_marked,
            position_x, position_y, entered_battlefield_turn_number
          )
          values (
            p_session_id, v_token_card_id, p_controller_id, p_controller_id,
            'battlefield', v_next_pos, false, 0, 0, 0, coalesce(v_turn_number, 0)
          )
          returning id into v_new_token_id;

          perform public.register_card_continuous_effects(p_session_id, v_new_token_id);
        end loop;
      end if;

    elsif v_eff_type = 'add_counters' then
      -- +1/+1 counters on the source permanent (e.g. "put a +1/+1 counter on it").
      if p_source_card_id is not null and v_eff_amount <> 0 then
        update public.game_cards
        set plus_one_counters = greatest(0, plus_one_counters + v_eff_amount)
        where id = p_source_card_id
          and session_id = p_session_id
          and zone = 'battlefield';

        -- Removing counters can drop a creature to lethal / 0 toughness.
        perform public.move_lethal_damaged_creatures_to_graveyard(p_session_id);
      end if;
    end if;
    -- Unknown effect types are ignored (forward-compatible).
  end loop;
end;
$$;

-- resolve_top_of_stack: slim the 'triggered_ability' branch to a single call to
-- the new helper. Reproduces the migration 076/077 body otherwise.
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
  v_target_stack_item public.game_stack_items;
  v_target_player_id uuid;
  v_target_card_id uuid;
  v_amount integer;
  v_next_battlefield_position integer;
  v_next_graveyard_position integer;
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
  elsif v_stack_item.action_type = 'deal_damage_creature' then
    v_target_card_id := nullif(v_stack_item.payload ->> 'target_card_id', '')::uuid;
    v_amount := coalesce((v_stack_item.payload ->> 'amount')::integer, 0);

    if v_target_card_id is not null and v_amount > 0 then
      update public.game_cards
      set damage_marked = damage_marked + v_amount
      where id = v_target_card_id
        and session_id = p_session_id
        and zone = 'battlefield';

      perform public.move_lethal_damaged_creatures_to_graveyard(p_session_id);
    end if;
  elsif v_stack_item.action_type = 'pump_creature' then
    v_target_card_id := nullif(v_stack_item.payload ->> 'target_card_id', '')::uuid;

    if v_target_card_id is not null
      and exists (
        select 1 from public.game_cards
        where id = v_target_card_id
          and session_id = p_session_id
          and zone = 'battlefield'
      )
    then
      perform public.create_pt_pump(
        p_session_id,
        v_target_card_id,
        coalesce((v_stack_item.payload ->> 'power')::integer, 0),
        coalesce((v_stack_item.payload ->> 'toughness')::integer, 0)
      );
    end if;
  elsif v_stack_item.action_type = 'counter_spell' then
    select *
    into v_target_stack_item
    from public.game_stack_items
    where id = nullif(v_stack_item.payload ->> 'target_stack_item_id', '')::uuid
      and session_id = p_session_id
      and status = 'pending'
    for update;

    if found then
      if v_target_stack_item.id = v_stack_item.id then
        raise exception 'A stack item cannot counter itself';
      end if;

      if v_target_stack_item.action_type = 'cast_permanent'
        and v_target_stack_item.source_card_id is not null
      then
        select coalesce(max(zone_position), -1) + 1
        into v_next_graveyard_position
        from public.game_cards
        where session_id = p_session_id
          and owner_id = v_target_stack_item.controller_player_id
          and zone = 'graveyard';

        update public.game_cards
        set
          zone = 'graveyard',
          zone_position = v_next_graveyard_position,
          is_tapped = false,
          damage_marked = 0
        where id = v_target_stack_item.source_card_id
          and session_id = p_session_id
          and owner_id = v_target_stack_item.controller_player_id
          and zone = 'stack';
      end if;

      update public.game_stack_items
      set
        status = 'cancelled',
        resolved_at = now()
      where id = v_target_stack_item.id;
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
  elsif v_stack_item.action_type = 'triggered_ability' then
    perform public.apply_triggered_ability_effects(
      p_session_id,
      nullif(v_stack_item.payload ->> 'controller_player_id', '')::uuid,
      v_stack_item.source_card_id,
      coalesce(v_stack_item.payload -> 'effects', '[]'::jsonb)
    );
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

-- Seed test cards for the two new effects.
insert into public.cards (id, name, type_line, mana_cost, power_toughness, oracle_text, script)
select gen_random_uuid(), v.name, v.type_line, v.mana_cost, v.power_toughness, v.oracle_text, v.script::jsonb
from (values
  (
    'Saproling Marshal Test',
    'Creature - Elf',
    '{2}{G}',
    '2/2',
    'At the beginning of your upkeep, create a 1/1 green Saproling creature token.',
    '{"schema_version":2,"triggered_abilities":[{"event":"beginning_of_upkeep","effects":[{"type":"create_token","token":"Saproling Token","count":1}]}]}'
  ),
  (
    'Relentless Charger Test',
    'Creature - Beast',
    '{1}{G}',
    '2/2',
    'Whenever Relentless Charger Test attacks, put a +1/+1 counter on it.',
    '{"schema_version":2,"triggered_abilities":[{"event":"attacks","effects":[{"type":"add_counters","amount":1}]}]}'
  )
) as v(name, type_line, mana_cost, power_toughness, oracle_text, script)
where not exists (
  select 1 from public.cards where lower(name) = lower(v.name)
);

grant execute on function public.apply_triggered_ability_effects(uuid, uuid, uuid, jsonb) to authenticated;
grant execute on function public.resolve_top_of_stack(uuid) to authenticated;
