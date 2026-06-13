-- supabase/functions_src/apply_enters_with_counters.sql
-- CANONICAL current definition (seeded from 202605010168_planeswalkers.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

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
  if NEW.zone <> 'battlefield' then
    return NEW;
  end if;
  if TG_OP = 'UPDATE' and OLD.zone = 'battlefield' then
    return NEW;
  end if;

  v_script := coalesce(NEW.copied_script, (select script from public.cards where id = NEW.card_id), '{}'::jsonb);

  -- Planeswalker starting loyalty (a loyalty counter; Doubling Season doubles it).
  if (v_script ->> 'loyalty') is not null then
    v_amount := coalesce((v_script ->> 'loyalty')::integer, 0)
              * public.counter_factor(NEW.session_id, NEW.controller_player_id);
    if v_amount > 0 then
      NEW.counters := public.adjust_counter_bag(coalesce(NEW.counters, '{}'::jsonb), 'loyalty', v_amount);
    end if;
  end if;

  -- "Enters the battlefield with N counters on it." `amount` may be a literal
  -- number, a dynamic spec ({count,...} / {counters,...}), or an ARRAY of specs
  -- summed (mig 210, Unbreathing Horde: "a +1/+1 counter for each other Zombie
  -- you control and each Zombie card in your graveyard" = two count specs).
  -- Timing note: this runs BEFORE the row lands, so on a spawn the card doesn't
  -- count itself on the battlefield, and a graveyard reanimation still counts
  -- itself in the graveyard — both rules-correct (the count is taken as it
  -- enters, while it is still in the previous zone).
  v_ewc := v_script -> 'enters_with_counters';
  if v_ewc is not null and jsonb_typeof(v_ewc) = 'object' then
    if jsonb_typeof(v_ewc -> 'amount') = 'array' then
      select coalesce(sum(public.resolve_dynamic_amount(
        NEW.session_id, NEW.id, coalesce(NEW.controller_player_id, NEW.owner_id), spec.value)), 0)
      into v_amount
      from jsonb_array_elements(v_ewc -> 'amount') spec;
    elsif jsonb_typeof(v_ewc -> 'amount') = 'object' then
      v_amount := public.resolve_dynamic_amount(
        NEW.session_id, NEW.id, coalesce(NEW.controller_player_id, NEW.owner_id), v_ewc -> 'amount');
    else
      v_amount := coalesce((v_ewc ->> 'amount')::integer, 0);
    end if;
    if v_amount > 0 then
      v_amount := v_amount * public.counter_factor(NEW.session_id, NEW.controller_player_id);
      v_counter_type := v_ewc ->> 'counter_type';
      if public.is_plus_one_counter(v_counter_type) then
        NEW.plus_one_counters := coalesce(NEW.plus_one_counters, 0) + v_amount;
      else
        NEW.counters := public.adjust_counter_bag(coalesce(NEW.counters, '{}'::jsonb), lower(v_counter_type), v_amount);
      end if;
    end if;
  end if;

  return NEW;
end;
$$;
