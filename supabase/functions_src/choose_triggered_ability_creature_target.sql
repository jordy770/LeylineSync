-- supabase/functions_src/choose_triggered_ability_creature_target.sql
-- CANONICAL current definition (seeded from 202605010131_protection_color_and_targeting.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs.
--
-- mig 310: enforce an optional type-line `target_filter` on the chosen target
-- (Opportunistic Dragon — "Human or artifact an opponent controls"), alongside
-- the existing controller + protection checks.

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

  if v_stack_item.action_type <> 'triggered_ability'
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
