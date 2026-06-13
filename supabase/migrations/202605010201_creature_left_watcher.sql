-- `creature_left` watcher event — "Whenever Vela the Night-Clad or another
-- creature you control LEAVES THE BATTLEFIELD, each opponent loses 1 life."
-- creature_died only covers battlefield→graveyard; Vela also counts exile and
-- bounce. New watcher event `creature_left` broadcast from the existing
-- leaves-the-battlefield branch (any battlefield→elsewhere move, INCLUDING a
-- death — a card that dies fires both creature_died and creature_left, which is
-- rules-correct: dying IS leaving).
--
-- fire_zone_change_triggers reproduced VERBATIM from mig 165 (its latest
-- definition; fire_watcher_triggers' latest is mig 181 and is untouched) with
-- ONLY the watcher broadcast added to the leaves branch. The changed card itself
-- is included in the broadcast (fire_watcher_triggers' self-inclusion), so Vela
-- leaving fires her own trigger.

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
