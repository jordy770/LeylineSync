-- Phase 3: targeted creature triggers.
--
-- Adds a first targeted-trigger slice without changing the stack model:
-- triggered_ability stack items may now carry target_required/target_card_id in
-- their payload. The trigger controller chooses the creature target via
-- choose_triggered_ability_creature_target before the item resolves.

create or replace function public.behavior_target_type_matches(
  p_target_type jsonb,
  p_want text
)
returns boolean
language sql
immutable
as $$
  select
    case
      when p_target_type is null then false
      when jsonb_typeof(p_target_type) = 'string' then
        lower(trim(both '"' from p_target_type::text)) in (lower(p_want), 'any')
      when jsonb_typeof(p_target_type) = 'array' then
        exists (
          select 1
          from jsonb_array_elements_text(p_target_type) as target_types(value)
          where lower(target_types.value) in (lower(p_want), 'any')
        )
      else false
    end;
$$;

create or replace function public.trigger_effect_requires_creature_target(
  p_effect jsonb
)
returns boolean
language sql
immutable
as $$
  select
    lower(coalesce(p_effect ->> 'type', '')) in (
      'deal_damage',
      'destroy',
      'bounce',
      'tap',
      'untap',
      'add_counters'
    )
    and public.behavior_target_type_matches(p_effect -> 'target_type', 'creature');
$$;

create or replace function public.trigger_effects_require_creature_target(
  p_effects jsonb
)
returns boolean
language sql
immutable
as $$
  select exists (
    select 1
    from jsonb_array_elements(coalesce(p_effects, '[]'::jsonb)) as effects(effect)
    where public.trigger_effect_requires_creature_target(effects.effect)
  );
$$;

create or replace function public.apply_targeted_triggered_ability_effects(
  p_session_id uuid,
  p_controller_id uuid,
  p_source_card_id uuid,
  p_effects jsonb,
  p_target_card_id uuid
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
  v_target_owner_id uuid;
  v_next_graveyard_position integer;
  v_next_hand_position integer;
begin
  for v_effect in
    select * from jsonb_array_elements(coalesce(p_effects, '[]'::jsonb))
  loop
    if not public.trigger_effect_requires_creature_target(v_effect) then
      perform public.apply_triggered_ability_effects(
        p_session_id,
        p_controller_id,
        p_source_card_id,
        jsonb_build_array(v_effect)
      );
      continue;
    end if;

    -- Targeted trigger effects fizzle harmlessly if the target is gone.
    v_eff_type := lower(coalesce(v_effect ->> 'type', ''));
    v_eff_amount := coalesce((v_effect ->> 'amount')::integer, 0);

    if v_eff_type = 'deal_damage' then
      if p_target_card_id is not null and v_eff_amount > 0 then
        update public.game_cards
        set damage_marked = damage_marked + v_eff_amount
        where id = p_target_card_id
          and session_id = p_session_id
          and zone = 'battlefield';

        perform public.move_lethal_damaged_creatures_to_graveyard(p_session_id);
      end if;

    elsif v_eff_type = 'destroy' then
      select owner_id
      into v_target_owner_id
      from public.game_cards
      where id = p_target_card_id
        and session_id = p_session_id
        and zone = 'battlefield';

      if found then
        select coalesce(max(zone_position), -1) + 1
        into v_next_graveyard_position
        from public.game_cards
        where session_id = p_session_id
          and owner_id = v_target_owner_id
          and zone = 'graveyard';

        update public.game_cards
        set
          zone = 'graveyard',
          zone_position = v_next_graveyard_position,
          controller_player_id = owner_id,
          is_tapped = false,
          damage_marked = 0,
          dealt_deathtouch_damage = false,
          plus_one_counters = 0
        where id = p_target_card_id;
      end if;

    elsif v_eff_type = 'bounce' then
      select owner_id
      into v_target_owner_id
      from public.game_cards
      where id = p_target_card_id
        and session_id = p_session_id
        and zone = 'battlefield';

      if found then
        select coalesce(max(zone_position), -1) + 1
        into v_next_hand_position
        from public.game_cards
        where session_id = p_session_id
          and owner_id = v_target_owner_id
          and zone = 'hand';

        update public.game_cards
        set
          zone = 'hand',
          zone_position = v_next_hand_position,
          controller_player_id = owner_id,
          is_tapped = false,
          damage_marked = 0,
          dealt_deathtouch_damage = false,
          plus_one_counters = 0
        where id = p_target_card_id;
      end if;

    elsif v_eff_type in ('tap', 'untap') then
      update public.game_cards
      set is_tapped = (v_eff_type = 'tap')
      where id = p_target_card_id
        and session_id = p_session_id
        and zone = 'battlefield';

    elsif v_eff_type = 'add_counters' then
      if p_target_card_id is not null and v_eff_amount > 0 then
        update public.game_cards
        set plus_one_counters = greatest(0, plus_one_counters + v_eff_amount)
        where id = p_target_card_id
          and session_id = p_session_id
          and zone = 'battlefield';
      end if;
    end if;
  end loop;
end;
$$;

create or replace function public.enqueue_triggered_ability(
  p_session_id uuid,
  p_controller_id uuid,
  p_source_card_id uuid,
  p_label text,
  p_effects jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next_position integer;
  v_requires_creature_target boolean;
  v_has_creature_target boolean;
begin
  if p_effects is null or jsonb_typeof(p_effects) <> 'array' or jsonb_array_length(p_effects) = 0 then
    return;
  end if;

  v_requires_creature_target := public.trigger_effects_require_creature_target(p_effects);

  if v_requires_creature_target then
    select exists (
      select 1
      from public.game_cards
      join public.cards on cards.id = game_cards.card_id
      where game_cards.session_id = p_session_id
        and game_cards.zone = 'battlefield'
        and cards.type_line ilike '%creature%'
    )
    into v_has_creature_target;

    if not v_has_creature_target then
      return;
    end if;
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
    p_controller_id,
    p_source_card_id,
    'triggered_ability',
    jsonb_build_object(
      'label', p_label,
      'controller_player_id', p_controller_id,
      'effects', p_effects,
      'target_required', v_requires_creature_target,
      'target_type', case when v_requires_creature_target then 'creature' else null end,
      'timing', 'triggered'
    ),
    v_next_position
  );
end;
$$;

create or replace function public.choose_triggered_ability_creature_target(
  p_session_id uuid,
  p_stack_item_id uuid,
  p_target_card_id uuid
)
returns public.game_stack_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stack_item public.game_stack_items;
  v_target_type_line text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select *
  into v_stack_item
  from public.game_stack_items
  where id = p_stack_item_id
    and session_id = p_session_id
    and status = 'pending'
  for update;

  if not found then
    raise exception 'Triggered ability stack item not found';
  end if;

  if v_stack_item.action_type <> 'triggered_ability'
    or coalesce((v_stack_item.payload ->> 'target_required')::boolean, false) is not true
  then
    raise exception 'Stack item does not require a trigger target';
  end if;

  if v_stack_item.controller_player_id <> auth.uid() then
    raise exception 'Only the trigger controller can choose its target';
  end if;

  select cards.type_line
  into v_target_type_line
  from public.game_cards
  join public.cards on cards.id = game_cards.card_id
  where game_cards.id = p_target_card_id
    and game_cards.session_id = p_session_id
    and game_cards.zone = 'battlefield';

  if not found then
    raise exception 'Target creature not found on battlefield';
  end if;

  if coalesce(v_target_type_line, '') not ilike '%creature%' then
    raise exception 'Target must be a creature';
  end if;

  update public.game_stack_items
  set payload = payload || jsonb_build_object(
    'target_card_id', p_target_card_id,
    'target_chosen', true
  )
  where id = v_stack_item.id
  returning * into v_stack_item;

  return v_stack_item;
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
  v_target_stack_item public.game_stack_items;
  v_target_player_id uuid;
  v_target_card_id uuid;
  v_target_owner_id uuid;
  v_amount integer;
  v_next_battlefield_position integer;
  v_next_graveyard_position integer;
  v_next_hand_position integer;
  v_finish_state jsonb;
  v_has_creature_target boolean;
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
  elsif v_stack_item.action_type = 'destroy_creature' then
    v_target_card_id := nullif(v_stack_item.payload ->> 'target_card_id', '')::uuid;

    select owner_id
    into v_target_owner_id
    from public.game_cards
    where id = v_target_card_id
      and session_id = p_session_id
      and zone = 'battlefield';

    if found then
      select coalesce(max(zone_position), -1) + 1
      into v_next_graveyard_position
      from public.game_cards
      where session_id = p_session_id
        and owner_id = v_target_owner_id
        and zone = 'graveyard';

      update public.game_cards
      set
        zone = 'graveyard',
        zone_position = v_next_graveyard_position,
        controller_player_id = owner_id,
        is_tapped = false,
        damage_marked = 0,
        dealt_deathtouch_damage = false,
        plus_one_counters = 0
      where id = v_target_card_id;
    end if;
  elsif v_stack_item.action_type = 'bounce_creature' then
    v_target_card_id := nullif(v_stack_item.payload ->> 'target_card_id', '')::uuid;

    select owner_id
    into v_target_owner_id
    from public.game_cards
    where id = v_target_card_id
      and session_id = p_session_id
      and zone = 'battlefield';

    if found then
      select coalesce(max(zone_position), -1) + 1
      into v_next_hand_position
      from public.game_cards
      where session_id = p_session_id
        and owner_id = v_target_owner_id
        and zone = 'hand';

      update public.game_cards
      set
        zone = 'hand',
        zone_position = v_next_hand_position,
        controller_player_id = owner_id,
        is_tapped = false,
        damage_marked = 0,
        dealt_deathtouch_damage = false,
        plus_one_counters = 0
      where id = v_target_card_id;
    end if;
  elsif v_stack_item.action_type in ('tap_creature', 'untap_creature') then
    v_target_card_id := nullif(v_stack_item.payload ->> 'target_card_id', '')::uuid;

    update public.game_cards
    set is_tapped = (v_stack_item.action_type = 'tap_creature')
    where id = v_target_card_id
      and session_id = p_session_id
      and zone = 'battlefield';
  elsif v_stack_item.action_type = 'add_counters_creature' then
    v_target_card_id := nullif(v_stack_item.payload ->> 'target_card_id', '')::uuid;
    v_amount := coalesce((v_stack_item.payload ->> 'amount')::integer, 0);

    if v_target_card_id is not null and v_amount > 0 then
      update public.game_cards
      set plus_one_counters = greatest(0, plus_one_counters + v_amount)
      where id = v_target_card_id
        and session_id = p_session_id
        and zone = 'battlefield';
    end if;
  elsif v_stack_item.action_type = 'draw_cards' then
    perform public.apply_triggered_ability_effects(
      p_session_id,
      v_stack_item.controller_player_id,
      null,
      jsonb_build_array(
        jsonb_build_object('type', 'draw', 'amount', coalesce((v_stack_item.payload ->> 'amount')::integer, 1))
      )
    );
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
    if coalesce((v_stack_item.payload ->> 'target_required')::boolean, false)
      and nullif(v_stack_item.payload ->> 'target_card_id', '') is null
    then
      select exists (
        select 1
        from public.game_cards
        join public.cards on cards.id = game_cards.card_id
        where game_cards.session_id = p_session_id
          and game_cards.zone = 'battlefield'
          and cards.type_line ilike '%creature%'
      )
      into v_has_creature_target;

      if v_has_creature_target then
        raise exception 'Triggered ability requires a target';
      end if;
    end if;

    perform public.apply_targeted_triggered_ability_effects(
      p_session_id,
      nullif(v_stack_item.payload ->> 'controller_player_id', '')::uuid,
      v_stack_item.source_card_id,
      coalesce(v_stack_item.payload -> 'effects', '[]'::jsonb),
      nullif(v_stack_item.payload ->> 'target_card_id', '')::uuid
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

insert into public.cards (id, name, type_line, mana_cost, oracle_text, script)
select gen_random_uuid(), v.name, v.type_line, v.mana_cost, v.oracle_text, v.script::jsonb
from (values
  (
    'Ravenous Chupacabra Test',
    'Creature',
    '{2}{B}{B}',
    'When Ravenous Chupacabra Test enters the battlefield, destroy target creature an opponent controls.',
    '{"schema_version":2,"triggered_abilities":[{"event":"enters_the_battlefield","effects":[{"type":"destroy","target_type":"creature"}]}]}'
  ),
  (
    'Ivy Gift Test',
    'Creature',
    '{1}{G}',
    'When Ivy Gift Test enters the battlefield, put a +1/+1 counter on target creature.',
    '{"schema_version":2,"triggered_abilities":[{"event":"enters_the_battlefield","effects":[{"type":"add_counters","amount":1,"target_type":"creature"}]}]}'
  )
) as v(name, type_line, mana_cost, oracle_text, script)
where not exists (
  select 1 from public.cards existing
  where existing.name = v.name
    and existing.type_line = v.type_line
);

grant execute on function public.behavior_target_type_matches(jsonb, text) to authenticated;
grant execute on function public.trigger_effect_requires_creature_target(jsonb) to authenticated;
grant execute on function public.trigger_effects_require_creature_target(jsonb) to authenticated;
grant execute on function public.apply_targeted_triggered_ability_effects(uuid, uuid, uuid, jsonb, uuid) to authenticated;
grant execute on function public.enqueue_triggered_ability(uuid, uuid, uuid, text, jsonb) to authenticated;
grant execute on function public.choose_triggered_ability_creature_target(uuid, uuid, uuid) to authenticated;
grant execute on function public.resolve_top_of_stack(uuid) to authenticated;
