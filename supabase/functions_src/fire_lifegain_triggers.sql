-- supabase/functions_src/fire_lifegain_triggers.sql
-- CANONICAL current definition (introduced in 202605010336_lifegain_event.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.
--
-- "Whenever you gain life, …" (Marauding Blight-Priest, mig 336). Life is gained
-- at ~6 scattered sites (the gain_life action, both lifelink paths, the then-rider,
-- gain_per_destroyed, Deathgorge's exile). Each calls this AFTER the increment with
-- the player who gained and how much. A player-scoped event (no card subject), so
-- it does not ride fire_watcher_triggers (which is keyed on a changed permanent).

create or replace function public.fire_lifegain_triggers(
  p_session_id uuid,
  p_player_id uuid,
  p_amount integer
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_watcher record;
  v_ability jsonb;
  v_controller text;
begin
  -- Only an actual gain fires "whenever you gain life" (0 or negative is no gain).
  if coalesce(p_amount, 0) <= 0 or p_player_id is null then
    return;
  end if;

  for v_watcher in
    select gc.id, gc.controller_player_id
    from public.game_cards gc
    where gc.session_id = p_session_id and gc.zone = 'battlefield'
    order by gc.controller_player_id, gc.id
  loop
    for v_ability in
      select * from jsonb_array_elements(
        coalesce(public.effective_script(p_session_id, v_watcher.id) -> 'triggered_abilities', '[]'::jsonb))
    loop
      if lower(coalesce(v_ability ->> 'event', '')) <> 'you_gain_life' then
        continue;
      end if;

      -- controller is relative to the player who gained life (default 'you' =
      -- the watcher's controller gained the life). 'any' fires for every player.
      v_controller := lower(coalesce(v_ability -> 'filter' ->> 'controller', 'you'));
      if (v_controller = 'you' and v_watcher.controller_player_id is distinct from p_player_id)
         or (v_controller = 'opponent' and v_watcher.controller_player_id = p_player_id) then
        continue;
      end if;

      perform public.enqueue_triggered_ability(
        p_session_id, v_watcher.controller_player_id, v_watcher.id,
        'you_gain_life', coalesce(v_ability -> 'effects', '[]'::jsonb),
        null, jsonb_build_object('event_amount', p_amount));
    end loop;
  end loop;
end;
$$;

grant execute on function public.fire_lifegain_triggers(uuid, uuid, integer) to authenticated;
