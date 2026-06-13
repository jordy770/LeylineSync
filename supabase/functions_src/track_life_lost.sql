-- supabase/functions_src/track_life_lost.sql
-- CANONICAL current definition (new in mig 294).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

-- BEFORE UPDATE OF life_total on game_session_players: accumulate any DECREASE
-- in a player's life into life_lost_this_turn (reset each turn by advance_step).
-- A single chokepoint for every life-loss source — combat damage, deal_damage,
-- lose_life, pay_life costs — so cards keyed on "lost life this turn"
-- (Y'shtola, Night's Blessed; Reaper's Scythe) read one maintained counter
-- without instrumenting each decrement site.
create or replace function public.track_life_lost() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.life_total < OLD.life_total then
    NEW.life_lost_this_turn := coalesce(NEW.life_lost_this_turn, 0) + (OLD.life_total - NEW.life_total);
  end if;
  return NEW;
end;
$$;
