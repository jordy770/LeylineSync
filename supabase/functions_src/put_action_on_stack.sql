-- supabase/functions_src/put_action_on_stack.sql
-- CANONICAL current definition (seeded from 202605010195_intimidate_hexproof.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

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
  v_action_timing text;
  v_target_controller text;
  v_source_type_line text;
  v_source_is_commander boolean := false;
  v_source_zone text;
  v_source_mana_cost text;
  v_generic_payment jsonb;
  v_x_value integer;
  v_pending_stack_count integer;
  v_next_graveyard_position integer;
  v_next_position integer;
  v_builder_fn text;
  v_built_payload jsonb;
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

  select builder_fn
  into v_builder_fn
  from public.stack_action_handlers
  where action_type = p_action_type;

  if v_builder_fn is null then
    raise exception 'Unsupported stack action type: %', p_action_type;
  end if;

  if p_source_card_id is not null then
    select cards.type_line, cards.mana_cost, game_cards.zone,
           coalesce(game_cards.is_commander, false)
    into v_source_type_line, v_source_mana_cost, v_source_zone,
         v_source_is_commander
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

  -- An EXILE source (mig 230 impulse, mig 296 adventure) requires a
  -- play_from_exile permission listing this card. The card pays its printed cost
  -- (below) and a non-permanent goes to the graveyard on cast.
  if p_source_card_id is not null and v_source_zone = 'exile' then
    if not exists (
      select 1 from public.game_continuous_effects ce
      where ce.session_id = p_session_id
        and ce.effect_type = 'play_from_exile'
        and ce.affected_player_id = auth.uid()
        and (ce.payload -> 'card_ids') ? p_source_card_id::text
    ) then
      raise exception 'You do not have permission to play that card from exile';
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
  v_x_value := coalesce((p_payload ->> 'x_value')::integer, 0);
  v_target_controller := coalesce(lower(nullif(p_payload ->> 'target_controller', '')), 'any');

  execute format('select public.%I($1, $2, $3, $4, $5)', v_builder_fn)
    into v_built_payload
    using p_session_id, auth.uid(), p_payload, v_action_timing, v_target_controller;

  -- Protection (CR 702.16e): a creature with protection from any of the source's
  -- colours can't be targeted. The target rode through the builder as target_card_id.
  if v_built_payload ? 'target_card_id'
     and public.card_has_protection_from_any(
           p_session_id,
           nullif(v_built_payload ->> 'target_card_id', '')::uuid,
           public.card_color_set(v_source_mana_cost))
  then
    raise exception 'Target has protection from this spell''s colour';
  end if;

  -- Hexproof: a permanent can't be targeted by a spell/ability an OPPONENT controls
  -- (the actor here is auth.uid(); you can still target your own hexproof permanents).
  if v_built_payload ? 'target_card_id'
     and public.card_has_hexproof(p_session_id, nullif(v_built_payload ->> 'target_card_id', '')::uuid)
     and (select coalesce(gc.controller_player_id, gc.owner_id)
          from public.game_cards gc
          where gc.id = nullif(v_built_payload ->> 'target_card_id', '')::uuid
            and gc.session_id = p_session_id) is distinct from auth.uid()
  then
    raise exception 'Target has hexproof and can''t be targeted by an opponent';
  end if;

  -- PLAYER hexproof (mig 203, Lazotep Plating "You … gain hexproof"): a player
  -- covered by an active hexproof grant with payload.includes_player can't be
  -- targeted by an opponent's spell/ability (targeting yourself stays legal).
  if v_built_payload ? 'target_player_id'
     and nullif(v_built_payload ->> 'target_player_id', '')::uuid is distinct from auth.uid()
     and exists (
       select 1 from public.game_continuous_effects effects
       where effects.session_id = p_session_id
         and effects.effect_type = 'hexproof'
         and effects.affected_card_id is null
         and (effects.payload ->> 'includes_player')::boolean is true
         and (effects.affected_player_id is null
              or effects.affected_player_id = nullif(v_built_payload ->> 'target_player_id', '')::uuid)
     )
  then
    raise exception 'Target player has hexproof and can''t be targeted by an opponent';
  end if;

  -- An exile cast (impulse) pays the printed cost too — impulse is not free.
  if p_source_card_id is not null and v_source_zone in ('hand', 'exile') then
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_source_mana_cost, v_generic_payment, v_x_value,
      p_pay_context := jsonb_build_object('kind', 'cast', 'type_line', coalesce(v_source_type_line, ''),
        'is_commander', v_source_is_commander));
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
    v_built_payload,
    v_next_position
  )
  returning * into v_stack_item;

  -- "Becomes the target of a spell or ability an opponent controls" (mig 235,
  -- Thunderbreak Regent). The target is locked in; the actor is auth.uid().
  if v_built_payload ? 'target_card_id' then
    perform public.fire_becomes_target_triggers(
      p_session_id, nullif(v_built_payload ->> 'target_card_id', '')::uuid, auth.uid());
  end if;

  if p_source_card_id is not null
     and coalesce((p_payload ->> 'adventure')::boolean, false)
  then
    -- Adventure (mig 296): the action is the adventure half of a creature card —
    -- exile the source with a non-expiring play_from_exile permission so its
    -- creature face can be cast from exile later (Hypnotic Sprite // Mesmeric
    -- Glare). Mirrors cast_spell_effect's p_adventure path (mig 295).
    update public.game_cards
    set
      zone = 'exile',
      zone_position = (
        select coalesce(max(zone_position), -1) + 1 from public.game_cards
        where session_id = p_session_id and owner_id = auth.uid() and zone = 'exile'),
      controller_player_id = owner_id,
      is_tapped = false,
      damage_marked = 0
    where id = p_source_card_id;

    insert into public.game_continuous_effects (
      session_id, source_card_id, affected_player_id, effect_type, payload
    ) values (
      p_session_id, p_source_card_id, auth.uid(), 'play_from_exile',
      jsonb_build_object('card_ids', jsonb_build_array(p_source_card_id), 'permanent', true));

  elsif p_source_card_id is not null
    and v_source_zone in ('hand', 'exile')
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
