-- "Enters the battlefield with N counters" (roadmap Counters #3).
--
-- A REPLACEMENT effect, not a trigger: the counters must be present the instant the
-- card enters, BEFORE state-based actions run — otherwise a 0/0 that "enters with two
-- +1/+1 counters" (Walking Ballista, Hangarback Walker) would die to the 0-toughness
-- SBA before an ETB trigger could ever resolve.
--
-- Implemented as a BEFORE INSERT/UPDATE-of-zone trigger on game_cards (same chokepoint
-- pattern as redirect_commander_zone_change, mig 142): when a card ENTERS the
-- battlefield and its effective script carries `enters_with_counters`, set the counters
-- on NEW before the row lands. A BEFORE trigger's NEW edits win over the statement's
-- own SET, so this also overrides the plus_one_counters = 0 that reanimate writes
-- (a returned permanent correctly re-enters with its counters).
--
-- Script shape (top-level): "enters_with_counters": { "amount": N, "counter_type"?: ... }.
-- counter_type absent / plus_one_one → the fast +1/+1 column; else the jsonb bag.
-- (IDE T-SQL false-positives on $$ bodies — ignore.)

create or replace function public.apply_enters_with_counters()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_script jsonb;
  v_ewc jsonb;
  v_amount integer;
  v_counter_type text;
begin
  -- Only when ENTERING the battlefield (INSERT onto it, or a move from another zone).
  if NEW.zone <> 'battlefield' then
    return NEW;
  end if;
  if TG_OP = 'UPDATE' and OLD.zone = 'battlefield' then
    return NEW;
  end if;

  -- Effective script = the card's copied script (if any) else its printed script.
  -- Read inline (NEW isn't committed yet, so effective_script() can't see it).
  v_script := coalesce(NEW.copied_script, (select script from public.cards where id = NEW.card_id), '{}'::jsonb);
  v_ewc := v_script -> 'enters_with_counters';
  if v_ewc is null or jsonb_typeof(v_ewc) <> 'object' then
    return NEW;
  end if;

  v_amount := coalesce((v_ewc ->> 'amount')::integer, 0);
  if v_amount <= 0 then
    return NEW;
  end if;
  v_counter_type := v_ewc ->> 'counter_type';

  if public.is_plus_one_counter(v_counter_type) then
    NEW.plus_one_counters := coalesce(NEW.plus_one_counters, 0) + v_amount;
  else
    NEW.counters := public.adjust_counter_bag(coalesce(NEW.counters, '{}'::jsonb), lower(v_counter_type), v_amount);
  end if;

  return NEW;
end;
$$;

drop trigger if exists apply_enters_with_counters on public.game_cards;
create trigger apply_enters_with_counters
  before insert or update of zone on public.game_cards
  for each row execute function public.apply_enters_with_counters();
