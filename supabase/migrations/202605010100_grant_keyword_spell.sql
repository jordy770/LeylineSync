-- Tier-2 effect: grant_keyword spell/combat-trick path.
--
-- Migration 099 shipped grant_keyword on the TRIGGER path only (an ETB/triggered
-- ability gives a creature a keyword until end of turn). This adds the INSTANT /
-- combat-trick path: a non-permanent spell whose effect is "target creature gains
-- <keyword> until end of turn" (think Sky-Blessing / a one-shot evasion trick).
--
-- The keyword is FIXED by the card's script (the author chose it), so casting only
-- needs a creature target — exactly like destroy_creature/exile_creature. The one
-- difference is the stack payload must carry `keyword`, which apply_creature_effect's
-- grant_keyword branch (mig 099) already reads.
--
-- Three reproduced surfaces, each adding `grant_keyword_creature` alongside the
-- existing creature-targeting stack actions:
--   1. game_stack_items action_type CHECK (last set in mig 094).
--   2. put_action_on_stack (baseline) — whitelist + identical creature validation
--      (+ keyword validation) + a payload branch carrying `keyword`. Goes through
--      put_action_on_stack (not cast_spell_effect) so it pays mana like other
--      creature-targeting spells.
--   3. resolve_top_of_stack (mig 094) — added to the collapsed creature `in (...)`
--      branch; regexp_replace('grant_keyword_creature','_creature$','') = 'grant_keyword'
--      dispatches to apply_creature_effect, which inserts the until-EOT continuous
--      effect. Expiry is handled by the existing cleanup sweep — no new lifecycle.
-- (IDE T-SQL false-positives on $$ bodies — ignore.)

alter table public.game_stack_items
  drop constraint if exists game_stack_items_action_type_check;
alter table public.game_stack_items
  add constraint game_stack_items_action_type_check
  check (action_type = any (array[
    'deal_damage_player', 'deal_damage_creature', 'pump_creature', 'cast_permanent',
    'counter_spell', 'triggered_ability', 'draw_cards', 'destroy_creature',
    'bounce_creature', 'tap_creature', 'untap_creature', 'add_counters_creature',
    'exile_creature', 'grant_keyword_creature', 'modal_spell', 'scry', 'surveil', 'spell_effect'
  ]));

-- put_action_on_stack: reproduced from the baseline with `grant_keyword_creature`
-- added to (a) the supported-action whitelist, (b) the shared creature-target
-- validation branch (+ keyword validation), and (c) the payload-building case.
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
  v_target_stack_item public.game_stack_items;
  v_target_stack_label text;
  v_amount integer;
  v_pump_power integer;
  v_pump_toughness integer;
  v_keyword text;
  v_action_timing text;
  v_target_controller text;
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
    'untap_creature',
    'add_counters_creature',
    'exile_creature',
    'grant_keyword_creature'
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
  v_target_controller := coalesce(lower(nullif(p_payload ->> 'target_controller', '')), 'any');

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

    if not public.creature_target_controller_ok(p_session_id, v_target_card_id, auth.uid(), v_target_controller) then
      raise exception 'Target is not a legal creature for this spell';
    end if;
  elsif p_action_type = 'pump_creature' then
    v_target_card_id := nullif(p_payload ->> 'target_card_id', '')::uuid;
    v_pump_power := coalesce((p_payload ->> 'power')::integer, 0);
    v_pump_toughness := coalesce((p_payload ->> 'toughness')::integer, 0);

    if v_target_card_id is null then
      raise exception 'target_card_id is required';
    end if;

    if not public.creature_target_controller_ok(p_session_id, v_target_card_id, auth.uid(), v_target_controller) then
      raise exception 'Target is not a legal creature for this spell';
    end if;
  elsif p_action_type in ('destroy_creature', 'bounce_creature', 'tap_creature', 'untap_creature', 'add_counters_creature', 'exile_creature', 'grant_keyword_creature') then
    -- These all target a creature on the battlefield; identical validation.
    v_target_card_id := nullif(p_payload ->> 'target_card_id', '')::uuid;
    v_amount := coalesce((p_payload ->> 'amount')::integer, 0);

    if v_target_card_id is null then
      raise exception 'target_card_id is required';
    end if;

    if p_action_type = 'add_counters_creature' and v_amount <= 0 then
      raise exception 'amount must be positive';
    end if;

    if p_action_type = 'grant_keyword_creature' then
      v_keyword := lower(coalesce(p_payload ->> 'keyword', ''));
      if v_keyword not in ('flying','reach','trample','vigilance','haste','first_strike','double_strike','deathtouch','indestructible') then
        raise exception 'Unsupported keyword grant: %', v_keyword;
      end if;
    end if;

    if not public.creature_target_controller_ok(p_session_id, v_target_card_id, auth.uid(), v_target_controller) then
      raise exception 'Target is not a legal creature for this spell';
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
          'target_controller', v_target_controller,
          'timing', v_action_timing
        )
      when p_action_type = 'pump_creature' then
        jsonb_build_object(
          'target_card_id', v_target_card_id,
          'power', v_pump_power,
          'toughness', v_pump_toughness,
          'target_controller', v_target_controller,
          'timing', v_action_timing
        )
      when p_action_type in ('destroy_creature', 'bounce_creature', 'tap_creature', 'untap_creature', 'exile_creature') then
        jsonb_build_object(
          'target_card_id', v_target_card_id,
          'target_controller', v_target_controller,
          'timing', v_action_timing
        )
      when p_action_type = 'add_counters_creature' then
        jsonb_build_object(
          'target_card_id', v_target_card_id,
          'amount', v_amount,
          'target_controller', v_target_controller,
          'timing', v_action_timing
        )
      when p_action_type = 'grant_keyword_creature' then
        jsonb_build_object(
          'target_card_id', v_target_card_id,
          'keyword', v_keyword,
          'target_controller', v_target_controller,
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

grant execute on function public.put_action_on_stack(uuid, text, jsonb, uuid) to authenticated;

-- resolve_top_of_stack: reproduced from mig 094 with `grant_keyword_creature` added
-- to the collapsed creature-effect branch. Everything else unchanged.
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
  v_amount integer;
  v_next_battlefield_position integer;
  v_next_graveyard_position integer;
  v_scry_options jsonb;
  v_decision_id uuid;
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
  elsif v_stack_item.action_type in (
    'deal_damage_creature',
    'pump_creature',
    'destroy_creature',
    'exile_creature',
    'bounce_creature',
    'tap_creature',
    'untap_creature',
    'add_counters_creature',
    'grant_keyword_creature'
  ) then
    perform public.apply_creature_effect(
      p_session_id,
      regexp_replace(v_stack_item.action_type, '_creature$', ''),
      nullif(v_stack_item.payload ->> 'target_card_id', '')::uuid,
      v_stack_item.payload
    );
  elsif v_stack_item.action_type = 'draw_cards' then
    perform public.apply_triggered_ability_effects(
      p_session_id,
      v_stack_item.controller_player_id,
      null,
      jsonb_build_array(
        jsonb_build_object('type', 'draw', 'amount', coalesce((v_stack_item.payload ->> 'amount')::integer, 1))
      )
    );
  elsif v_stack_item.action_type in ('scry', 'surveil') then
    v_amount := coalesce((v_stack_item.payload ->> 'amount')::integer, 1);

    select coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'game_card_id', top.id,
                 'name', c.name,
                 'library_position', top.zone_position
               )
               order by top.zone_position asc, top.id asc
             ),
             '[]'::jsonb
           )
      into v_scry_options
    from (
      select id, card_id, zone_position
      from public.game_cards
      where session_id = p_session_id
        and owner_id = v_stack_item.controller_player_id
        and zone = 'library'
      order by zone_position asc, id asc
      limit v_amount
    ) top
    join public.cards c on c.id = top.card_id;

    if jsonb_array_length(v_scry_options) = 0 then
      return public.finalize_stack_resolution(p_session_id, v_stack_item.id);
    end if;

    insert into public.game_pending_decisions (
      session_id, deciding_player_id, source_stack_item_id, decision_type,
      prompt, options, min_choices, max_choices
    )
    values (
      p_session_id,
      v_stack_item.controller_player_id,
      v_stack_item.id,
      v_stack_item.action_type,
      initcap(v_stack_item.action_type) || ' ' || v_amount,
      v_scry_options,
      0,
      jsonb_array_length(v_scry_options)
    )
    returning id into v_decision_id;

    update public.game_stack_items
    set status = 'awaiting_decision'
    where id = v_stack_item.id;

    return jsonb_build_object(
      'awaiting_decision', true,
      'decision_id', v_decision_id,
      'decision_type', v_stack_item.action_type,
      'stack_item_id', v_stack_item.id
    );
  elsif v_stack_item.action_type = 'spell_effect' then
    v_decision_id := public.apply_trigger_effects(p_session_id, v_stack_item.id, 0);
    if v_decision_id is not null then
      return jsonb_build_object(
        'awaiting_decision', true,
        'decision_id', v_decision_id,
        'stack_item_id', v_stack_item.id
      );
    end if;
  elsif v_stack_item.action_type = 'modal_spell' then
    perform public.apply_modal_spell(p_session_id, v_stack_item.id);
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
      if public.session_has_targetable_creature(
        p_session_id,
        nullif(v_stack_item.payload ->> 'controller_player_id', '')::uuid,
        coalesce(v_stack_item.payload ->> 'target_controller', 'any')
      ) then
        raise exception 'Triggered ability requires a target';
      end if;
    end if;

    v_decision_id := public.apply_trigger_effects(p_session_id, v_stack_item.id, 0);
    if v_decision_id is not null then
      return jsonb_build_object(
        'awaiting_decision', true,
        'decision_id', v_decision_id,
        'stack_item_id', v_stack_item.id
      );
    end if;
  else
    raise exception 'Unsupported stack action type: %', v_stack_item.action_type;
  end if;

  return public.finalize_stack_resolution(p_session_id, v_stack_item.id);
end;
$$;

grant execute on function public.resolve_top_of_stack(uuid) to authenticated;
