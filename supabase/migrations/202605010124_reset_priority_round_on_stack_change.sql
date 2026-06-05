-- Phase 4 / F1b — restart the priority round when a new object enters the stack.
--
-- pass_priority counts consecutive passes and resolves / advances once all N
-- players pass in a row. But nothing reset that count when a player ADDED an
-- object to the stack, so a respond-then-pass short-circuited the round:
--   2 players. A passes (count=1). B, instead of passing, casts a spell — count
--   stays 1. B passes (count=2 >= 2) -> the spell resolves and A NEVER got to
--   respond. Bug.
--
-- A new stack object means every player must get priority again (CR 117.3c /
-- 405.3). Rather than reset the round in each of the ~8 cast/ability paths (each a
-- big reproduce-the-whole-function migration), one AFTER INSERT trigger on
-- game_stack_items resets priority_pass_count for every path at once — including
-- triggered abilities being enqueued, where a fresh priority round is likewise
-- correct. priority_player_id is left untouched: the caster keeps priority, and
-- resolve_top_of_stack / step code already hand it to the active player when due.
--
-- This complements F1a (mig 123, APNAP trigger ORDERING); together they are F1.

create or replace function public.reset_priority_round_on_stack_change()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  -- Guard on <> 0 so a batch of simultaneous inserts only updates turn_state once
  -- and we never churn a row that is already at the round's start.
  update public.game_turn_state
  set priority_pass_count = 0,
      priority_cycle_started_by = null
  where session_id = NEW.session_id
    and priority_pass_count <> 0;
  return NEW;
end;
$$;

-- Name sorts after trg_fire_target so target-triggers enqueue first; harmless
-- either way (each resulting insert also resets the count).
drop trigger if exists trg_reset_priority_on_stack_insert on public.game_stack_items;
create trigger trg_reset_priority_on_stack_insert
  after insert on public.game_stack_items
  for each row
  execute function public.reset_priority_round_on_stack_change();
