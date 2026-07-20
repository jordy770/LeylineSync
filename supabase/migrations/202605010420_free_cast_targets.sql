-- free_cast_targets
-- TODO: describe the change.
-- Generated from supabase/functions_src (spell_free_cast_target_spec, cast_card_free, choose_triggered_ability_targets, choose_triggered_ability_creature_target) — those files are
-- the canonical current definitions; edit them, not past migrations.

create or replace function public.spell_free_cast_target_spec(p_actions jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_tt jsonb;
begin
  if p_actions is null or jsonb_typeof(p_actions) <> 'array' then
    return jsonb_build_object('required', false);
  end if;
  v_tt := public.trigger_effects_target_type(p_actions);
  if v_tt is null then
    return jsonb_build_object('required', false);
  end if;
  return jsonb_build_object(
    'required', true,
    'target_type', v_tt,
    'target_controller', coalesce(public.trigger_effects_target_controller(p_actions), 'any'),
    'target_count', coalesce(public.trigger_effects_target_count(p_actions), 1));
end;
$$;
grant execute on function public.spell_free_cast_target_spec(jsonb) to authenticated;

create or replace function public.cast_card_free(
  p_session_id uuid, p_game_card_id uuid, p_controller uuid
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_type_line text;
  v_card_id uuid;
  v_script jsonb;
  v_actions jsonb;
  v_next_position integer;
  v_is_permanent boolean;
  v_spec jsonb;
  v_stack_item_id uuid;
begin
  select gc.card_id, c.type_line, public.effective_script(p_session_id, p_game_card_id)
    into v_card_id, v_type_line, v_script
  from public.game_cards gc join public.cards c on c.id = gc.card_id
  where gc.id = p_game_card_id and gc.session_id = p_session_id;

  v_is_permanent := v_type_line ilike any (array[
    '%creature%','%artifact%','%enchantment%','%planeswalker%','%battle%','%land%']);

  if v_is_permanent then
    -- Real cast: push a cast_permanent stack item from exile (mirrors
    -- cast_card_from_hand:480-515, minus payment). Resolves with true ETBs.
    select coalesce(max(position), -1) + 1 into v_next_position
    from public.game_stack_items where session_id = p_session_id;

    update public.game_cards
    set zone = 'stack', zone_position = v_next_position, is_tapped = false, damage_marked = 0
    where id = p_game_card_id and session_id = p_session_id;

    insert into public.game_stack_items (
      session_id, controller_player_id, source_card_id, action_type, payload, position)
    values (
      p_session_id, p_controller, p_game_card_id, 'cast_permanent',
      jsonb_build_object('timing', 'sorcery', 'card_id', v_card_id, 'type_line', v_type_line, 'free', true),
      v_next_position);

    -- perform public.enqueue_cast_triggers(p_session_id, p_game_card_id, p_controller); -- enabled in Task 5
    return null;
  end if;

  -- Instant / sorcery.
  v_actions := v_script -> 'spell_effect' -> 'actions';
  if v_actions is null or jsonb_typeof(v_actions) <> 'array' then
    -- Unsupported shape → caller bottoms it (fallback). Signal with a sentinel.
    return '00000000-0000-0000-0000-000000000000'::uuid;
  end if;

  -- Does the spell need a cast-time target? If so, park it in the triggered-ability
  -- target shape and let choose_triggered_ability_(creature_)target set the target
  -- (guards relaxed to accept 'spell_effect'); apply_trigger_effects resolves the
  -- effects against the chosen target when the item resolves.
  v_spec := public.spell_free_cast_target_spec(v_actions);
  if coalesce((v_spec ->> 'required')::boolean, false) then
    select coalesce(max(position), -1) + 1 into v_next_position
    from public.game_stack_items where session_id = p_session_id;
    insert into public.game_stack_items (
      session_id, controller_player_id, source_card_id, action_type, payload, position, status)
    values (
      p_session_id, p_controller, p_game_card_id, 'spell_effect',
      jsonb_build_object(
        'effects', v_actions, 'controller_player_id', p_controller, 'timing', 'instant',
        'free_cast', true, 'target_required', true,
        'target_type', v_spec -> 'target_type',
        'target_controller', v_spec ->> 'target_controller',
        'target_count', (v_spec ->> 'target_count')::integer),
      v_next_position, 'pending')
    returning id into v_stack_item_id;
    -- The instant/sorcery leaves exile for the graveyard on cast (mirrors
    -- cast_spell_effect's cast-time zone move). A permanent spell reaches this
    -- branch only as an Aura (targets); Auras are out of scope for now.
    if v_type_line ilike '%instant%' or v_type_line ilike '%sorcery%' then
      update public.game_cards
      set zone = 'graveyard',
          zone_position = (select coalesce(max(zone_position), -1) + 1 from public.game_cards x
                           where x.session_id = p_session_id and x.owner_id = game_cards.owner_id and x.zone = 'graveyard')
      where id = p_game_card_id and session_id = p_session_id;
    end if;
    return v_stack_item_id;
  end if;

  perform public.cast_spell_effect(p_session_id, v_actions, p_game_card_id, 0, null, false, true);
  return null;
end;
$$;
grant execute on function public.cast_card_free(uuid, uuid, uuid) to authenticated;

create or replace function public.choose_triggered_ability_targets(
  p_session_id uuid, p_stack_item_id uuid, p_target_card_ids uuid[]
) returns public.game_stack_items
language plpgsql security definer set search_path = public
as $$
declare
  v_stack_item public.game_stack_items;
  v_target_type jsonb;
  v_count integer;
  v_max integer;
  v_id uuid;
  v_seen uuid[] := array[]::uuid[];
  v_ok boolean;
  v_per_opponent boolean;
  v_ctrl uuid;
  v_seen_controllers uuid[] := array[]::uuid[];
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
  where id = p_stack_item_id and session_id = p_session_id and status = 'pending'
  for update;

  if not found then
    raise exception 'Triggered ability stack item not found';
  end if;
  -- The trigger must be able to target — required OR optional (mig 404, Angel
  -- of Serenity: "you may exile up to three OTHER target creatures" is an
  -- optional multi-target, so target_required is false but target_optional true).
  -- 'spell_effect' (mig 420): a free nested-cast (cast_card_free) parks its found
  -- spell in this same target shape. The target_required/optional gate below still
  -- scopes this to free-cast items — a normal cast-from-hand spell_effect carries
  -- neither flag, so it is still rejected here.
  if v_stack_item.action_type not in ('triggered_ability', 'spell_effect')
    or not (coalesce((v_stack_item.payload ->> 'target_required')::boolean, false)
            or coalesce((v_stack_item.payload ->> 'target_optional')::boolean, false)) then
    raise exception 'Stack item does not require a trigger target';
  end if;
  if v_stack_item.controller_player_id <> auth.uid() then
    raise exception 'Only the trigger controller can choose its target';
  end if;

  v_count := coalesce(array_length(p_target_card_ids, 1), 0);
  v_max := greatest(1, coalesce((v_stack_item.payload ->> 'target_count')::integer, 1));
  if v_count < 1 or v_count > v_max then
    raise exception 'Choose between 1 and % target(s)', v_max;
  end if;

  v_target_type := v_stack_item.payload -> 'target_type';
  v_per_opponent := coalesce((v_stack_item.payload ->> 'per_opponent')::boolean, false);

  foreach v_id in array p_target_card_ids loop
    if v_id = any(v_seen) then
      raise exception 'A target may not be chosen more than once';
    end if;
    v_seen := array_append(v_seen, v_id);

    if v_target_type is null or public.behavior_target_type_is_creature_only(v_target_type) then
      v_ok := public.creature_target_controller_ok(
        p_session_id, v_id, v_stack_item.controller_player_id,
        coalesce(v_stack_item.payload ->> 'target_controller', 'any'));
    else
      v_ok := public.permanent_target_controller_ok(
        p_session_id, v_id, v_stack_item.controller_player_id,
        coalesce(v_stack_item.payload ->> 'target_controller', 'any'), v_target_type);
    end if;
    if not v_ok then
      raise exception 'Target is not a legal target for this ability';
    end if;

    -- per_opponent (mig 415): "for each opponent, up to one … that player
    -- controls" — at most one target may come from each opponent.
    if v_per_opponent then
      select coalesce(gc.controller_player_id, gc.owner_id) into v_ctrl
      from public.game_cards gc where gc.id = v_id and gc.session_id = p_session_id;
      if v_ctrl = any(v_seen_controllers) then
        raise exception 'At most one target may be chosen per opponent';
      end if;
      v_seen_controllers := array_append(v_seen_controllers, v_ctrl);
    end if;
  end loop;

  update public.game_stack_items
  set payload = payload || jsonb_build_object('target_card_ids', to_jsonb(p_target_card_ids), 'target_chosen', true)
  where id = v_stack_item.id
  returning * into v_stack_item;

  return v_stack_item;
end;
$$;
grant execute on function public.choose_triggered_ability_targets(uuid, uuid, uuid[]) to authenticated;

create or replace function public.choose_triggered_ability_creature_target(
  p_session_id uuid, p_stack_item_id uuid, p_target_card_id uuid
) returns public.game_stack_items
language plpgsql security definer set search_path = public
as $$
declare
  v_stack_item public.game_stack_items;
  v_target_type jsonb;
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
  where id = p_stack_item_id and session_id = p_session_id and status = 'pending'
  for update;

  if not found then
    raise exception 'Triggered ability stack item not found';
  end if;

  -- 'spell_effect' (mig 420): a free nested-cast parks its found spell in the same
  -- target shape; the target_required/optional gate still scopes this to free casts.
  if v_stack_item.action_type not in ('triggered_ability', 'spell_effect')
    or (coalesce((v_stack_item.payload ->> 'target_required')::boolean, false) is not true
        and coalesce((v_stack_item.payload ->> 'target_optional')::boolean, false) is not true)
  then
    raise exception 'Stack item does not require a trigger target';
  end if;

  if v_stack_item.controller_player_id <> auth.uid() then
    raise exception 'Only the trigger controller can choose its target';
  end if;

  v_target_type := v_stack_item.payload -> 'target_type';

  if v_target_type is null or public.behavior_target_type_is_creature_only(v_target_type) then
    if not public.creature_target_controller_ok(
      p_session_id, p_target_card_id, v_stack_item.controller_player_id,
      coalesce(v_stack_item.payload ->> 'target_controller', 'any')
    ) then
      raise exception 'Target is not a legal creature for this ability';
    end if;
  else
    if not public.permanent_target_controller_ok(
      p_session_id, p_target_card_id, v_stack_item.controller_player_id,
      coalesce(v_stack_item.payload ->> 'target_controller', 'any'), v_target_type
    ) then
      raise exception 'Target is not a legal permanent for this ability';
    end if;
  end if;

  -- Type-line restriction (mig 310): a payload `target_filter` narrows the legal
  -- targets by type line (Opportunistic Dragon: Human or artifact). Null = no
  -- restriction.
  if v_stack_item.payload -> 'target_filter' is not null then
    select c.type_line into v_target_type_line
    from public.game_cards gc
    join public.cards c on c.id = gc.card_id
    where gc.id = p_target_card_id and gc.session_id = p_session_id;

    if not public.card_type_line_matches_filter(v_target_type_line, v_stack_item.payload -> 'target_filter') then
      raise exception 'Target does not match this ability''s type restriction';
    end if;
  end if;

  -- Protection: the chosen target can't have protection from the trigger source's
  -- colour(s). The source card's mana cost gives its colours.
  if public.card_has_protection_from_any(
       p_session_id, p_target_card_id,
       public.card_color_set((
         select c.mana_cost
         from public.game_cards gc
         join public.cards c on c.id = gc.card_id
         where gc.id = v_stack_item.source_card_id
       ))) then
    raise exception 'Target has protection from this ability''s colour';
  end if;

  update public.game_stack_items
  set payload = payload || jsonb_build_object('target_card_id', p_target_card_id, 'target_chosen', true)
  where id = v_stack_item.id
  returning * into v_stack_item;

  return v_stack_item;
end;
$$;
grant all on function public.choose_triggered_ability_creature_target(uuid, uuid, uuid) to anon, authenticated, service_role;
