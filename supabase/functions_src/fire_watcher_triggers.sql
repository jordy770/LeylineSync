-- supabase/functions_src/fire_watcher_triggers.sql
-- CANONICAL current definition (seeded from 202605010181_watcher_nontoken_filter.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

create or replace function public.fire_watcher_triggers(
  p_session_id uuid,
  p_changed_card_id uuid,
  p_changed_controller uuid,
  p_event text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changed_type text;
  v_changed_is_token boolean;
  v_watcher record;
  v_ability jsonb;
  v_filter jsonb;
  v_f_type text;
  v_f_controller text;
  v_exclude_self boolean;
  v_ctrl_ok boolean;
begin
  select cards.type_line, coalesce(cards.is_token, false)
  into v_changed_type, v_changed_is_token
  from public.game_cards gc
  join public.cards on cards.id = gc.card_id
  where gc.id = p_changed_card_id and gc.session_id = p_session_id;

  for v_watcher in
    select gc.id, coalesce(gc.controller_player_id, gc.owner_id) as controller, c.name as card_name
    from public.game_cards gc
    join public.cards c on c.id = gc.card_id
    where gc.session_id = p_session_id
      and (gc.zone = 'battlefield' or gc.id = p_changed_card_id)
    order by gc.controller_player_id, gc.id
  loop
    for v_ability in
      select * from jsonb_array_elements(
        coalesce(public.effective_script(p_session_id, v_watcher.id) -> 'triggered_abilities', '[]'::jsonb))
    loop
      if lower(coalesce(v_ability ->> 'event', '')) <> p_event then
        continue;
      end if;

      v_filter := v_ability -> 'filter';
      v_f_type := v_filter ->> 'type_line';
      v_f_controller := lower(coalesce(v_filter ->> 'controller', 'you'));
      v_exclude_self := coalesce((v_filter ->> 'exclude_self')::boolean, false);

      -- "another …": skip when the changed card IS the watcher.
      if v_exclude_self and v_watcher.id = p_changed_card_id then
        continue;
      end if;

      -- "nontoken …": skip when the changed creature is a token.
      if coalesce((v_filter ->> 'nontoken')::boolean, false) and v_changed_is_token then
        continue;
      end if;

      -- Type filter: default "creature"; else substring-match the subtype.
      if v_changed_type not ilike '%' || coalesce(v_f_type, 'creature') || '%' then
        continue;
      end if;

      -- Power filter (mig 225): "a creature with power N or greater enters"
      -- (Elemental Bond, Temur Ascendancy). Reads the changed card's effective
      -- power; non-creatures (no P/T) never qualify.
      if v_filter ? 'min_power'
         and coalesce(public.card_effective_power(p_session_id, p_changed_card_id), -1)
             < (v_filter ->> 'min_power')::integer then
        continue;
      end if;

      -- Keyword filter (mig 227): "a creature you control WITH FLYING enters"
      -- (Dragon Tempest). Only 'flying' is supported (the common case). At the
      -- entry instant the granted-flying row isn't registered yet (the resolver
      -- registers AFTER the move), so check INTRINSIC flying — the card's own
      -- keywords or a source-scoped flying continuous effect — OR an already
      -- registered grant.
      if lower(coalesce(v_filter ->> 'has_keyword', '')) = 'flying'
         and not (
           public.card_has_flying(p_session_id, p_changed_card_id)
           or exists (
             select 1
             from public.game_cards gc
             left join public.cards c on c.id = gc.card_id
             where gc.id = p_changed_card_id and gc.session_id = p_session_id
               and (
                 coalesce(c.keywords::text, '') ilike '%flying%'
                 or exists (
                   select 1
                   from jsonb_array_elements(
                     coalesce(public.effective_script(p_session_id, gc.id) -> 'continuous_effects', '[]'::jsonb)) e
                   where lower(coalesce(e ->> 'type', e ->> 'effect_type', '')) = 'flying'
                     and coalesce(e ->> 'affected', 'source') in ('source', 'this')
                 )
               )
           )
         ) then
        continue;
      end if;

      -- Controller filter, relative to the WATCHER's controller.
      v_ctrl_ok := case v_f_controller
        when 'you' then p_changed_controller = v_watcher.controller
        when 'opponent' then p_changed_controller is distinct from v_watcher.controller
        else true
      end;
      if not v_ctrl_ok then
        continue;
      end if;

      perform public.enqueue_triggered_ability(
        p_session_id, v_watcher.controller, v_watcher.id,
        coalesce(v_watcher.card_name, p_event), v_ability -> 'effects',
        p_changed_card_id  -- the triggering creature, for reflexive "it gains …"
      );
    end loop;
  end loop;
end;
$$;
grant execute on function public.fire_watcher_triggers(uuid, uuid, uuid, text) to authenticated;
grant execute on function public.fire_watcher_triggers(uuid, uuid, uuid, text) to service_role;
