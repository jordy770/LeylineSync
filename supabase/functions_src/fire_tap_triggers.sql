-- supabase/functions_src/fire_tap_triggers.sql
-- CANONICAL (new in mig 283). Edit THIS file, then generate a migration with
-- scripts/new-migration.mjs — never re-extract from past migrations.

-- "Whenever ~ becomes tapped" / "whenever a creature an opponent controls
-- becomes tapped" (mig 283: Phyrexian Atlas, Scaretiller, Rhoda, Verity
-- Circle). An AFTER-UPDATE row trigger on game_cards catches EVERY tap path
-- (attacks, costs, effects, manual taps) in one place — the same pattern as
-- fire_zone_change_triggers. Untap (true→false) fires nothing.
create or replace function public.fire_tap_triggers() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.zone = 'battlefield'
     and coalesce(OLD.is_tapped, false) = false
     and NEW.is_tapped = true
  then
    perform public.fire_card_triggers(
      NEW.session_id, NEW.id, array['becomes_tapped']
    );
    perform public.fire_watcher_triggers(
      NEW.session_id, NEW.id,
      coalesce(NEW.controller_player_id, NEW.owner_id), 'creature_became_tapped'
    );
  end if;
  return null;
end;
$$;
