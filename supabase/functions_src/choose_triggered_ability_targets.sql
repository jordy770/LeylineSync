-- supabase/functions_src/choose_triggered_ability_targets.sql
-- CANONICAL current definition (seeded from 202605010116_multi_target_triggers.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

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
  if v_stack_item.action_type <> 'triggered_ability'
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
