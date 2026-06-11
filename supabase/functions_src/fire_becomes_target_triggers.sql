-- supabase/functions_src/fire_becomes_target_triggers.sql
-- CANONICAL current definition (new in 202605010235_target_and_exert.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.
--
-- "Whenever a <type> you control becomes the target of a spell or ability an
-- opponent controls, …" (Thunderbreak Regent). Broadcast from put_action_on_stack
-- when a target is locked in. The targeting player is injected into the trigger's
-- damage effects as recipient_player_id so "deals N to that player" hits them.

create or replace function public.fire_becomes_target_triggers(
  p_session_id uuid,
  p_target_card_id uuid,
  p_targeting_player uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_type text;
  v_target_controller uuid;
  v_watcher record;
  v_ability jsonb;
  v_filter jsonb;
  v_f_type text;
begin
  if p_target_card_id is null or p_targeting_player is null then
    return;
  end if;

  select c.type_line, coalesce(gc.controller_player_id, gc.owner_id)
  into v_target_type, v_target_controller
  from public.game_cards gc join public.cards c on c.id = gc.card_id
  where gc.id = p_target_card_id and gc.session_id = p_session_id and gc.zone = 'battlefield';
  if not found then
    return;
  end if;

  for v_watcher in
    select gc.id, coalesce(gc.controller_player_id, gc.owner_id) as controller, c.name as card_name
    from public.game_cards gc join public.cards c on c.id = gc.card_id
    where gc.session_id = p_session_id and gc.zone = 'battlefield'
    order by gc.controller_player_id, gc.id
  loop
    -- The targeted permanent must be controlled by the watcher (yours) and the
    -- targeting player must be an opponent of the watcher.
    if v_target_controller is distinct from v_watcher.controller then continue; end if;
    if p_targeting_player = v_watcher.controller then continue; end if;

    for v_ability in
      select * from jsonb_array_elements(
        coalesce(public.effective_script(p_session_id, v_watcher.id) -> 'triggered_abilities', '[]'::jsonb))
    loop
      if lower(coalesce(v_ability ->> 'event', '')) <> 'becomes_target' then continue; end if;
      v_filter := v_ability -> 'filter';
      v_f_type := v_filter ->> 'type_line';
      if v_f_type is not null and v_target_type not ilike '%' || v_f_type || '%' then continue; end if;

      perform public.enqueue_triggered_ability(
        p_session_id, v_watcher.controller, v_watcher.id,
        coalesce(v_watcher.card_name, 'becomes_target'),
        (select jsonb_agg(e || jsonb_build_object('recipient_player_id', p_targeting_player::text))
         from jsonb_array_elements(v_ability -> 'effects') e),
        p_target_card_id);
    end loop;
  end loop;
end;
$$;
grant execute on function public.fire_becomes_target_triggers(uuid, uuid, uuid) to authenticated;
grant execute on function public.fire_becomes_target_triggers(uuid, uuid, uuid) to service_role;
