-- Phase 3, Tier 1 effects: exile and mill.
--
--   exile  — targeted creature effect (spell `exile_creature` + triggered `exile`).
--            Mirrors destroy but moves the creature to its owner's exile zone, with
--            full leave-the-battlefield cleanup. Fires leaves_the_battlefield (zone
--            change away from battlefield) but NOT dies (that is battlefield→graveyard).
--   mill   — auto-resolved triggered effect: a recipient mills N cards from the top
--            of their library into their graveyard. recipient: controller (default),
--            each_opponent, each_player/all_players. (Spell-side / player-targeted
--            mill is deferred — it needs a player target picker.)

-- 1. Allow the new exile_creature stack action.
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
  'untap_creature',
  'add_counters_creature',
  'exile_creature'
));

-- 2. trigger_effect_requires_creature_target: exile joins the creature-targeting
--    effect types (must still be creature-only target_type).
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
      'exile',
      'bounce',
      'tap',
      'untap',
      'add_counters'
    )
    and public.behavior_target_type_is_creature_only(p_effect -> 'target_type');
$$;

-- 3. apply_triggered_ability_effects: add the mill branch. Reproduces migration
--    078's body otherwise.
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
  v_next_graveyard_position integer;
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

    elsif v_eff_type = 'mill' then
      -- A recipient mills N cards from the top of their library to their graveyard.
      if v_eff_amount > 0 then
        if v_recipient = 'controller' or v_recipient = '' then
          v_recipients := array[p_controller_id];
        elsif v_recipient in ('each_player', 'all_players') then
          select array_agg(player_id)
          into v_recipients
          from public.game_session_players
          where session_id = p_session_id;
        else
          -- each_opponent
          select array_agg(player_id)
          into v_recipients
          from public.game_session_players
          where session_id = p_session_id
            and player_id is distinct from p_controller_id;
        end if;

        foreach v_rid in array coalesce(v_recipients, array[]::uuid[])
        loop
          if v_rid is not null then
            for v_draw_i in 1..v_eff_amount loop
              select coalesce(max(zone_position), -1) + 1
              into v_next_graveyard_position
              from public.game_cards
              where session_id = p_session_id
                and owner_id = v_rid
                and zone = 'graveyard';

              select id
              into v_lib_card
              from public.game_cards
              where session_id = p_session_id
                and owner_id = v_rid
                and zone = 'library'
              order by zone_position asc, id asc
              limit 1
              for update skip locked;

              exit when v_lib_card is null;

              update public.game_cards
              set zone = 'graveyard', zone_position = v_next_graveyard_position, is_tapped = false
              where id = v_lib_card;
            end loop;
          end if;
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

-- 4. apply_targeted_triggered_ability_effects: add the exile branch. Reproduces
--    migration 080's body otherwise.
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
  v_next_exile_position integer;
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

    elsif v_eff_type = 'exile' then
      select owner_id
      into v_target_owner_id
      from public.game_cards
      where id = p_target_card_id
        and session_id = p_session_id
        and zone = 'battlefield';

      if found then
        select coalesce(max(zone_position), -1) + 1
        into v_next_exile_position
        from public.game_cards
        where session_id = p_session_id
          and owner_id = v_target_owner_id
          and zone = 'exile';

        update public.game_cards
        set
          zone = 'exile',
          zone_position = v_next_exile_position,
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

-- 5. put_action_on_stack: add exile_creature (validated exactly like destroy_creature).
--    Reproduces migration 081's body.
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
    'exile_creature'
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
  elsif p_action_type in ('destroy_creature', 'bounce_creature', 'tap_creature', 'untap_creature', 'add_counters_creature', 'exile_creature') then
    -- These all target a creature on the battlefield; identical validation.
    v_target_card_id := nullif(p_payload ->> 'target_card_id', '')::uuid;
    v_amount := coalesce((p_payload ->> 'amount')::integer, 0);

    if v_target_card_id is null then
      raise exception 'target_card_id is required';
    end if;

    if p_action_type = 'add_counters_creature' and v_amount <= 0 then
      raise exception 'amount must be positive';
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

-- 6. resolve_top_of_stack: add the exile_creature branch (mirrors destroy_creature
--    to the exile zone). Reproduces migration 081's body otherwise.
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
  v_next_exile_position integer;
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
  elsif v_stack_item.action_type = 'exile_creature' then
    v_target_card_id := nullif(v_stack_item.payload ->> 'target_card_id', '')::uuid;

    select owner_id
    into v_target_owner_id
    from public.game_cards
    where id = v_target_card_id
      and session_id = p_session_id
      and zone = 'battlefield';

    if found then
      select coalesce(max(zone_position), -1) + 1
      into v_next_exile_position
      from public.game_cards
      where session_id = p_session_id
        and owner_id = v_target_owner_id
        and zone = 'exile';

      update public.game_cards
      set
        zone = 'exile',
        zone_position = v_next_exile_position,
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
      if public.session_has_targetable_creature(
        p_session_id,
        nullif(v_stack_item.payload ->> 'controller_player_id', '')::uuid,
        coalesce(v_stack_item.payload ->> 'target_controller', 'any')
      ) then
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

-- 7. Seed test cards: exile spell, exile ETB trigger, and a mill trigger.
insert into public.cards (id, name, type_line, mana_cost, power_toughness, oracle_text, script)
select gen_random_uuid(), v.name, v.type_line, v.mana_cost, v.power_toughness, v.oracle_text, v.script::jsonb
from (values
  (
    'Banishing Bolt Test',
    'Instant',
    '{1}{W}',
    null,
    'Exile target creature.',
    '{"schema_version":2,"spell_effect":{"actions":[{"type":"exile","target_type":"creature"}]}}'
  ),
  (
    'Banisher Priest Test',
    'Creature - Human Cleric',
    '{1}{W}',
    '2/2',
    'When Banisher Priest Test enters the battlefield, exile target creature an opponent controls.',
    '{"schema_version":2,"triggered_abilities":[{"event":"enters_the_battlefield","effects":[{"type":"exile","target_type":"creature","target_controller":"opponent"}]}]}'
  ),
  (
    'Grinding Scholar Test',
    'Creature - Wizard',
    '{2}{U}',
    '1/3',
    'When Grinding Scholar Test enters the battlefield, each opponent mills three cards.',
    '{"schema_version":2,"triggered_abilities":[{"event":"enters_the_battlefield","effects":[{"type":"mill","amount":3,"recipient":"each_opponent"}]}]}'
  )
) as v(name, type_line, mana_cost, power_toughness, oracle_text, script)
where not exists (
  select 1 from public.cards where lower(name) = lower(v.name)
);

grant execute on function public.trigger_effect_requires_creature_target(jsonb) to authenticated;
grant execute on function public.apply_triggered_ability_effects(uuid, uuid, uuid, jsonb) to authenticated;
grant execute on function public.apply_targeted_triggered_ability_effects(uuid, uuid, uuid, jsonb, uuid) to authenticated;
grant execute on function public.put_action_on_stack(uuid, text, jsonb, uuid) to authenticated;
grant execute on function public.resolve_top_of_stack(uuid) to authenticated;
