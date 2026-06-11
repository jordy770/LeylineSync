-- 202605010254_enrage — the enrage event ("whenever this creature is dealt
-- damage"): apply_damage_to_creature broadcasts dealt_damage/enrage triggers
-- with the damage amount BEFORE the lethal sweep, so a dying creature still
-- enrages. Cards: Ripjaw Raptor (draw), Ranging Raptors (basic-land search),
-- and the script-only Marauding Raptor (creature cost reduction + 2 damage
-- to each other entering creature — which chains into enrage).
-- Generated from supabase/functions_src (apply_damage_to_creature) — those files are
-- the canonical current definitions; edit them, not past migrations.

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

    -- Enrage (mig 254, Ripjaw Raptor / Ranging Raptors): "whenever this
    -- creature is dealt damage." Broadcast BEFORE the lethal sweep so the
    -- trigger fires even when the damage kills it (rules-correct); the
    -- enqueued trigger resolves later.
    perform public.fire_card_triggers(
      p_session_id, p_card_id, array['dealt_damage', 'enrage'],
      jsonb_build_object('event_amount', v_remaining));

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
