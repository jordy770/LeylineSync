-- 202605010238_landfall — Nesting Dragon (landfall) + Sarkhan cost reduction.
--   • fire_zone_change_triggers broadcasts a `land_entered` watcher event on every
--     battlefield entry; fire_watcher_triggers defaults that event's type filter
--     to 'land', so only land entries match. Nesting Dragon: "Whenever a land you
--     control enters, create a 0/2 Dragon Egg token" (whose own dies trigger makes
--     a 2/2 flying Dragon Hatchling). Tokens are seeded catalog rows with scripts.
--   • Sarkhan, Soul Aflame ships its cost_reduction half only (the become-a-copy
--     ability is not modelled) — no engine change, reuses mig 231.
-- Generated from supabase/functions_src (fire_zone_change_triggers, fire_watcher_triggers).

create or replace function public.fire_zone_change_triggers() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Enters the battlefield.
  if NEW.zone = 'battlefield'
    and (TG_OP = 'INSERT' or OLD.zone is distinct from 'battlefield')
  then
    perform public.fire_card_triggers(
      NEW.session_id, NEW.id,
      array['enters_the_battlefield', 'etb', 'enters']
    );
    perform public.fire_watcher_triggers(
      NEW.session_id, NEW.id,
      coalesce(NEW.controller_player_id, NEW.owner_id), 'creature_entered'
    );
    -- Landfall (mig 238, Nesting Dragon): "whenever a land you control enters."
    -- Fired for every entry; the watcher's type filter defaults to 'land' for
    -- this event, so only land entries actually match.
    perform public.fire_watcher_triggers(
      NEW.session_id, NEW.id,
      coalesce(NEW.controller_player_id, NEW.owner_id), 'land_entered'
    );
  end if;

  -- Dies (moves from the battlefield to the graveyard).
  if TG_OP = 'UPDATE'
    and OLD.zone = 'battlefield'
    and NEW.zone = 'graveyard'
  then
    perform public.fire_card_triggers(
      NEW.session_id, NEW.id,
      array['dies', 'death']
    );
    -- OLD.controller = the creature's controller while it was alive.
    perform public.fire_watcher_triggers(
      NEW.session_id, NEW.id,
      coalesce(OLD.controller_player_id, OLD.owner_id), 'creature_died'
    );
  end if;

  -- Leaves the battlefield (to any other zone, including graveyard/hand/exile).
  if TG_OP = 'UPDATE'
    and OLD.zone = 'battlefield'
    and NEW.zone is distinct from 'battlefield'
  then
    perform public.fire_card_triggers(
      NEW.session_id, NEW.id,
      array['leaves_the_battlefield', 'ltb', 'leaves']
    );
    -- Watcher broadcast (mig 201): "whenever a creature you control leaves the
    -- battlefield" (Vela the Night-Clad). OLD.controller = controller while it
    -- was on the battlefield.
    perform public.fire_watcher_triggers(
      NEW.session_id, NEW.id,
      coalesce(OLD.controller_player_id, OLD.owner_id), 'creature_left'
    );
  end if;

  return null;
end;
$$;

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

      -- Type filter: default "creature" for permanent watchers; spell_cast
      -- (Taurean Mauler) matches a SPELL of any type; land_entered (Nesting
      -- Dragon landfall) defaults to 'land' so only land entries match.
      if v_changed_type not ilike '%' || coalesce(v_f_type,
           case p_event when 'spell_cast' then '' when 'land_entered' then 'land' else 'creature' end) || '%' then
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
