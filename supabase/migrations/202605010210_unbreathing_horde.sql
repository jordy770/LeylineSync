-- Unbreathing Horde — "This creature enters with a +1/+1 counter on it for each
-- other Zombie you control and each Zombie card in your graveyard. If this
-- creature would be dealt damage, prevent that damage and remove a +1/+1
-- counter from it." Two replacement-shaped additions:
--   apply_enters_with_counters: enters_with_counters.amount may now be a
--     dynamic spec or an ARRAY of specs (summed via resolve_dynamic_amount);
--     BEFORE-trigger timing makes the other/graveyard self-counting exact.
--   apply_damage_to_creature: a top-level `damage_removes_counters: true` flag
--     prevents the whole damage event and removes ONE +1/+1 counter instead
--     (counter-state recheck handles the 0-toughness SBA). Applies to combat
--     damage too (resolve_combat_damage routes through this resolver).
-- Generated from supabase/functions_src (apply_enters_with_counters, apply_damage_to_creature) — those files are
-- the canonical current definitions; edit them, not past migrations.

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

create or replace function public.apply_damage_to_creature(
  p_session_id uuid,
  p_card_id uuid,
  p_amount integer,
  p_source_card_id uuid default null,
  p_is_combat boolean default false,
  p_deathtouch boolean default false,
  p_run_sweep boolean default true,
  p_as_minus_counters boolean default false
) returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_remaining integer := greatest(0, coalesce(p_amount, 0));
  v_turn integer;
  v_shield record;
  v_prevent integer;
begin
  if v_remaining <= 0 then
    return 0;
  end if;

  -- Counter shield (mig 210, Unbreathing Horde): "If this creature would be
  -- dealt damage, prevent that damage and remove a +1/+1 counter from it." A
  -- top-level script flag `damage_removes_counters: true` — the WHOLE damage
  -- event is prevented and ONE +1/+1 counter is removed (if any; the
  -- replacement applies even at zero). The counter-state recheck handles the
  -- resulting 0-toughness SBA.
  if exists (
    select 1 from public.game_cards gc
    where gc.id = p_card_id and gc.session_id = p_session_id and gc.zone = 'battlefield'
      and coalesce((public.effective_script(p_session_id, gc.id) ->> 'damage_removes_counters')::boolean, false)
  ) then
    update public.game_cards
    set plus_one_counters = greatest(0, coalesce(plus_one_counters, 0) - 1)
    where id = p_card_id and session_id = p_session_id;
    if p_run_sweep then
      perform public.recheck_counter_state(p_session_id);
    end if;
    return 0;
  end if;

  select turn_number into v_turn
  from public.game_turn_state where session_id = p_session_id;

  for v_shield in
    select * from public.game_damage_prevention
    where session_id = p_session_id
      and affected_card_id = p_card_id
      and (combat_only = false or p_is_combat = true)
      and (expires_turn is null or expires_turn >= coalesce(v_turn, 0))
    order by created_at asc, id asc
    for update
  loop
    exit when v_remaining <= 0;

    if v_shield.amount is null then
      v_remaining := 0;
    else
      v_prevent := least(v_remaining, v_shield.amount);
      v_remaining := v_remaining - v_prevent;
      if v_shield.amount - v_prevent <= 0 then
        delete from public.game_damage_prevention where id = v_shield.id;
      else
        update public.game_damage_prevention
        set amount = amount - v_prevent
        where id = v_shield.id;
      end if;
    end if;
  end loop;

  if v_remaining > 0 then
    if p_as_minus_counters then
      -- wither / infect: damage becomes −1/−1 counters (still "damage" for the
      -- toughness SBA; deathtouch-via-counters is a known deferred gap).
      update public.game_cards
      set counters = public.adjust_counter_bag(counters, 'minus_one_one', v_remaining)
      where id = p_card_id
        and session_id = p_session_id
        and zone = 'battlefield';
    else
      update public.game_cards
      set damage_marked = damage_marked + v_remaining,
          dealt_deathtouch_damage = dealt_deathtouch_damage or coalesce(p_deathtouch, false)
      where id = p_card_id
        and session_id = p_session_id
        and zone = 'battlefield';
    end if;

    -- Combat defers the lethal sweep to its single end-of-step pass (simultaneity).
    if p_run_sweep then
      if p_as_minus_counters then
        perform public.recheck_counter_state(p_session_id);
      else
        perform public.move_lethal_damaged_creatures_to_graveyard(p_session_id);
      end if;
    end if;
  end if;

  return v_remaining;
end;
$$;
