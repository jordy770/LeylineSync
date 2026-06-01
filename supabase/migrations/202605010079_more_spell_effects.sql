-- Phase 3: broaden spell_effect coverage with more effect types.
--
-- Adds five stack action types so instants/sorceries can do more than burn and
-- pump:
--   draw_cards       payload { amount }                 -> controller draws N
--   destroy_creature payload { target_card_id }         -> target creature to graveyard
--   bounce_creature  payload { target_card_id }         -> target creature to owner's hand
--   tap_creature     payload { target_card_id }         -> tap target creature
--   untap_creature   payload { target_card_id }         -> untap target creature
--
-- The four creature-targeted types share the existing target-validation pattern
-- (target must be a creature on the battlefield) and reuse the V4 creature target
-- picker. draw_cards is untargeted and resolves by reusing
-- apply_triggered_ability_effects' draw loop for the controller.
--
-- Reproduces put_action_on_stack (migration 071) and resolve_top_of_stack
-- (migration 078) verbatim except for the new branches.

alter table public.game_stack_items
drop constraint if exists game_stack_items_action_type_check;

alter table public.game_stack_items
add constraint game_stack_items_action_type_check
check (action_type in (
  'deal_damage_player',
  'deal_damage_creature',
  'pump_creature',
  'cast_permanent',
  'counter_spell',
  'triggered_ability',
  'draw_cards',
  'destroy_creature',
  'bounce_creature',
  'tap_creature',
  'untap_creature'
));

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
  v_target_card_id uuid;
  v_target_type_line text;
  v_target_stack_item public.game_stack_items;
  v_target_stack_label text;
  v_amount integer;
  v_pump_power integer;
  v_pump_toughness integer;
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

  if p_action_type not in (
    'deal_damage_player',
    'deal_damage_creature',
    'pump_creature',
    'counter_spell',
    'draw_cards',
    'destroy_creature',
    'bounce_creature',
    'tap_creature',
    'untap_creature'
  ) then
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

  if p_action_type = 'counter_spell' and v_action_timing <> 'instant' then
    raise exception 'Counterspell actions must use instant timing';
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

  v_generic_payment := p_payload -> 'generic_payment';

  if p_action_type = 'deal_damage_player' then
    v_target_player_id := nullif(p_payload ->> 'target_player_id', '')::uuid;
    v_amount := coalesce((p_payload ->> 'amount')::integer, 0);

    if v_target_player_id is null then
      raise exception 'target_player_id is required';
    end if;

    if v_amount <= 0 then
      raise exception 'amount must be positive';
    end if;

    if not public.is_session_player(p_session_id, v_target_player_id) then
      raise exception 'Target player is not a player in this session';
    end if;
  elsif p_action_type = 'deal_damage_creature' then
    v_target_card_id := nullif(p_payload ->> 'target_card_id', '')::uuid;
    v_amount := coalesce((p_payload ->> 'amount')::integer, 0);

    if v_target_card_id is null then
      raise exception 'target_card_id is required';
    end if;

    if v_amount <= 0 then
      raise exception 'amount must be positive';
    end if;

    select cards.type_line
    into v_target_type_line
    from public.game_cards
    join public.cards on cards.id = game_cards.card_id
    where game_cards.id = v_target_card_id
      and game_cards.session_id = p_session_id
      and game_cards.zone = 'battlefield';

    if not found then
      raise exception 'Target creature not found on battlefield';
    end if;

    if coalesce(v_target_type_line, '') not ilike '%creature%' then
      raise exception 'Target must be a creature';
    end if;
  elsif p_action_type = 'pump_creature' then
    v_target_card_id := nullif(p_payload ->> 'target_card_id', '')::uuid;
    v_pump_power := coalesce((p_payload ->> 'power')::integer, 0);
    v_pump_toughness := coalesce((p_payload ->> 'toughness')::integer, 0);

    if v_target_card_id is null then
      raise exception 'target_card_id is required';
    end if;

    select cards.type_line
    into v_target_type_line
    from public.game_cards
    join public.cards on cards.id = game_cards.card_id
    where game_cards.id = v_target_card_id
      and game_cards.session_id = p_session_id
      and game_cards.zone = 'battlefield';

    if not found then
      raise exception 'Target creature not found on battlefield';
    end if;

    if coalesce(v_target_type_line, '') not ilike '%creature%' then
      raise exception 'Target must be a creature';
    end if;
  elsif p_action_type in ('destroy_creature', 'bounce_creature', 'tap_creature', 'untap_creature') then
    -- These all target a creature on the battlefield; identical validation.
    v_target_card_id := nullif(p_payload ->> 'target_card_id', '')::uuid;

    if v_target_card_id is null then
      raise exception 'target_card_id is required';
    end if;

    select cards.type_line
    into v_target_type_line
    from public.game_cards
    join public.cards on cards.id = game_cards.card_id
    where game_cards.id = v_target_card_id
      and game_cards.session_id = p_session_id
      and game_cards.zone = 'battlefield';

    if not found then
      raise exception 'Target creature not found on battlefield';
    end if;

    if coalesce(v_target_type_line, '') not ilike '%creature%' then
      raise exception 'Target must be a creature';
    end if;
  elsif p_action_type = 'draw_cards' then
    v_amount := coalesce((p_payload ->> 'amount')::integer, 0);

    if v_amount <= 0 then
      raise exception 'amount must be positive';
    end if;
  elsif p_action_type = 'counter_spell' then
    select *
    into v_target_stack_item
    from public.game_stack_items
    where id = nullif(p_payload ->> 'target_stack_item_id', '')::uuid
      and session_id = p_session_id
      and status = 'pending'
    for update;

    if not found then
      raise exception 'Target stack item not found or no longer pending';
    end if;

    select coalesce(source_card.name, v_target_stack_item.action_type)
    into v_target_stack_label
    from public.game_stack_items target_stack
    left join public.game_cards source_instance
      on source_instance.id = target_stack.source_card_id
    left join public.cards source_card
      on source_card.id = source_instance.card_id
    where target_stack.id = v_target_stack_item.id;
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
    case
      when p_action_type = 'deal_damage_player' then
        jsonb_build_object(
          'target_player_id', v_target_player_id,
          'amount', v_amount,
          'timing', v_action_timing
        )
      when p_action_type = 'deal_damage_creature' then
        jsonb_build_object(
          'target_card_id', v_target_card_id,
          'amount', v_amount,
          'timing', v_action_timing
        )
      when p_action_type = 'pump_creature' then
        jsonb_build_object(
          'target_card_id', v_target_card_id,
          'power', v_pump_power,
          'toughness', v_pump_toughness,
          'timing', v_action_timing
        )
      when p_action_type in ('destroy_creature', 'bounce_creature', 'tap_creature', 'untap_creature') then
        jsonb_build_object(
          'target_card_id', v_target_card_id,
          'timing', v_action_timing
        )
      when p_action_type = 'draw_cards' then
        jsonb_build_object(
          'amount', v_amount,
          'timing', v_action_timing
        )
      else
        jsonb_build_object(
          'target_stack_item_id', v_target_stack_item.id,
          'target_stack_label', coalesce(v_target_stack_label, v_target_stack_item.action_type),
          'timing', v_action_timing
        )
    end,
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
    -- Move target to its owner's graveyard. Fizzles if it already left.
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
    -- Return target to its owner's hand. Fizzles if it already left.
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
  elsif v_stack_item.action_type = 'draw_cards' then
    -- Reuse the trigger effect helper's draw loop for the controller.
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

-- Seed test spells exercising each new effect.
insert into public.cards (id, name, type_line, mana_cost, oracle_text, script)
select gen_random_uuid(), v.name, v.type_line, v.mana_cost, v.oracle_text, v.script::jsonb
from (values
  (
    'Doom Blade Test',
    'Instant',
    '{1}{B}',
    'Destroy target creature.',
    '{"schema_version":2,"spell_effect":{"actions":[{"type":"destroy","target_type":"creature"}]}}'
  ),
  (
    'Unsummon Test',
    'Instant',
    '{U}',
    'Return target creature to its owner''s hand.',
    '{"schema_version":2,"spell_effect":{"actions":[{"type":"bounce","target_type":"creature"}]}}'
  ),
  (
    'Sleep Ray Test',
    'Instant',
    '{U}',
    'Tap target creature.',
    '{"schema_version":2,"spell_effect":{"actions":[{"type":"tap","target_type":"creature"}]}}'
  ),
  (
    'Wake Up Test',
    'Instant',
    '{U}',
    'Untap target creature.',
    '{"schema_version":2,"spell_effect":{"actions":[{"type":"untap","target_type":"creature"}]}}'
  ),
  (
    'Divination Test',
    'Sorcery',
    '{2}{U}',
    'Draw two cards.',
    '{"schema_version":2,"spell_effect":{"actions":[{"type":"draw","amount":2}]}}'
  )
) as v(name, type_line, mana_cost, oracle_text, script)
where not exists (
  select 1 from public.cards where lower(name) = lower(v.name)
);

grant execute on function public.put_action_on_stack(uuid, text, jsonb, uuid) to authenticated;
grant execute on function public.resolve_top_of_stack(uuid) to authenticated;
