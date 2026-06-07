-- Counter-placement trigger event (roadmap Tribal #3). "Whenever ~ / a creature you
-- control gets a +1/+1 counter" (Cathars' Crusade, Conclave Mentor, Sage of Fables).
--
-- Rather than fire from each counter-placement code path (apply_creature_effect,
-- apply_triggered_ability_effects add_counters/all, Doubling Season, judge tools), a
-- single AFTER UPDATE OF plus_one_counters trigger on game_cards catches EVERY +1/+1
-- increase uniformly — no function reproductions. It reuses fire_watcher_triggers
-- (mig 165) with the event `creature_got_counter`: the card that got the counter is the
-- "changed card", so the watcher's filter (type_line / controller / exclude_self) and
-- the self-inclusion (a card can watch its OWN counters) work exactly as for
-- creature_entered / creature_died.
--
-- Only +1/+1 INCREASES fire (NEW > OLD) — annihilation (recheck_counter_state) and
-- removal DECREASE the column and are correctly ignored. Entering-with-counters sets
-- the column on INSERT (not UPDATE), so it does not count as "getting" a counter.
-- (IDE T-SQL false-positives on $$ bodies — ignore.)

create or replace function public.fire_counter_triggers()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.plus_one_counters > coalesce(OLD.plus_one_counters, 0) then
    perform public.fire_watcher_triggers(
      NEW.session_id, NEW.id,
      coalesce(NEW.controller_player_id, NEW.owner_id), 'creature_got_counter'
    );
  end if;
  return null;
end;
$$;

drop trigger if exists fire_counter_triggers on public.game_cards;
create trigger fire_counter_triggers
  after update of plus_one_counters on public.game_cards
  for each row execute function public.fire_counter_triggers();
