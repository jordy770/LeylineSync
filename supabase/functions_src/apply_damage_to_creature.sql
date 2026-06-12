-- supabase/functions_src/apply_damage_to_creature.sql
-- CANONICAL current definition (seeded from 202605010159_infect_toxic_wither.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

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
  v_cap integer;
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

  -- Static damage cap (mig 259, Temple Altisaur: "if a source would deal
  -- damage to ANOTHER Dinosaur you control, prevent all but 1"). A fielded
  -- 'damage_cap' row caps damage to matching creatures sharing its source's
  -- controller; the protector never caps damage to itself.
  if v_remaining > 0 then
    select min(greatest(1, coalesce((ce.payload ->> 'cap')::integer, 1))) into v_cap
    from public.game_continuous_effects ce
    join public.game_cards src
      on src.id = ce.source_card_id and src.session_id = ce.session_id
    join public.game_cards tgt on tgt.id = p_card_id and tgt.session_id = p_session_id
    join public.cards tc on tc.id = tgt.card_id
    where ce.session_id = p_session_id
      and ce.effect_type = 'damage_cap'
      and src.zone = 'battlefield'
      and ce.source_card_id <> p_card_id
      and coalesce(src.controller_player_id, src.owner_id)
          = coalesce(tgt.controller_player_id, tgt.owner_id)
      and tc.type_line ilike '%' || coalesce(ce.payload ->> 'type_line', '') || '%';
    if v_cap is not null then
      v_remaining := least(v_remaining, v_cap);
    end if;
  end if;

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

    -- Lifelink (mig 283): the source's controller gains the damage dealt.
    if p_source_card_id is not null
       and public.card_has_lifelink(p_session_id, p_source_card_id) then
      update public.game_session_players
      set life_total = life_total + v_remaining
      where session_id = p_session_id
        and player_id = (select coalesce(gc.controller_player_id, gc.owner_id)
                         from public.game_cards gc
                         where gc.id = p_source_card_id and gc.session_id = p_session_id);
    end if;

    -- Watcher broadcast (mig 260, Wrathful Raptors: "whenever a Dinosaur you
    -- control is dealt damage"). The amount rides the payload as event_amount.
    perform public.fire_watcher_triggers(
      p_session_id, p_card_id,
      (select coalesce(gc.controller_player_id, gc.owner_id)
       from public.game_cards gc
       where gc.id = p_card_id and gc.session_id = p_session_id),
      'creature_damaged',
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
