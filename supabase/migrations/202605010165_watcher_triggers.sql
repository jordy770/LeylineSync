-- Other-scoped trigger events (roadmap Tribal #1, second half).
--
-- The trigger engine fires only a card's OWN triggers (fire_card_triggers reads that
-- card's triggered_abilities). Tribal/aristocrats decks need triggers that watch OTHER
-- permanents: "Whenever another Zombie you control enters" (Champion of the Perished),
-- "Whenever a creature you control dies" (Midnight Reaper, Open the Graves, Diregraf
-- Captain, Vengeful Dead).
--
-- New triggered-ability events `creature_entered` / `creature_died` (distinct from the
-- self events enters_the_battlefield / dies) with an optional `filter`:
--   filter.type_line    — the entered/died card must match this subtype (default any
--                         creature; "Zombie" for tribal).
--   filter.controller   — relative to the WATCHER's controller: "you" (default),
--                         "opponent", or "any".
--   filter.exclude_self — true = "another …" (the watcher does not fire off itself).
--
-- fire_watcher_triggers broadcasts the event to every battlefield permanent PLUS the
-- changed card itself — a dying creature can watch its OWN death (leaves-the-battlefield
-- timing / last-known information, so Midnight Reaper triggers when it dies). The
-- watcher's ability is enqueued with the WATCHER as source (effects act on it: "put a
-- counter on ~", "draw", "each opponent loses life"). Deaths use OLD.controller (the
-- living controller); enters use NEW.controller.
--
-- Reproduced from CURRENT (grep-first): fire_zone_change_triggers (baseline). New
-- function fire_watcher_triggers. (IDE T-SQL false-positives on $$ bodies — ignore.)

-- ===========================================================================
-- fire_watcher_triggers — broadcast a creature enter/death to OTHER permanents' watchers.
-- ===========================================================================
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
  v_watcher record;
  v_ability jsonb;
  v_filter jsonb;
  v_f_type text;
  v_f_controller text;
  v_exclude_self boolean;
  v_ctrl_ok boolean;
begin
  select cards.type_line
  into v_changed_type
  from public.game_cards gc
  join public.cards on cards.id = gc.card_id
  where gc.id = p_changed_card_id and gc.session_id = p_session_id;

  -- Watchers = battlefield permanents PLUS the changed card itself (so a dying creature
  -- can watch its own death). Ordered by controller then id for deterministic enqueue.
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

      -- Type filter: default "creature"; else substring-match the subtype.
      if v_changed_type not ilike '%' || coalesce(v_f_type, 'creature') || '%' then
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
        coalesce(v_watcher.card_name, p_event), v_ability -> 'effects'
      );
    end loop;
  end loop;
end;
$$;
grant execute on function public.fire_watcher_triggers(uuid, uuid, uuid, text) to authenticated;
grant execute on function public.fire_watcher_triggers(uuid, uuid, uuid, text) to service_role;

-- ===========================================================================
-- fire_zone_change_triggers (CURRENT = baseline) — after a card's OWN enter/death
-- triggers, broadcast the event to other permanents' watchers. Verbatim otherwise.
-- ===========================================================================
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
  end if;

  return null;
end;
$$;
