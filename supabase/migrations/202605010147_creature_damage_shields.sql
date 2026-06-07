-- Phase 4 / F2.1d — CREATURE damage shields (the creature analogue of mig 125).
--
-- F2.1a built apply_damage_to_player + game_damage_prevention (affected_card_id was
-- reserved here for exactly this). This adds the creature resolver and routes the
-- TARGETED creature-damage chokepoint (apply_creature_effect 'deal_damage' — Shock,
-- pingers, fight, deal_damage_creature) through it, so "prevent the next N damage to
-- target creature" works against spells/abilities.
--
-- A creature shield consumes damage before it is marked. amount null = prevent ALL
-- (persists for the turn); combat_only restricts it to combat. Damage != life loss;
-- only damage routes here. With NO shield the resolver is byte-identical to the old
-- inline branch (mark damage + lethal sweep), so all prior creature-damage tests are
-- unaffected.
--
-- SCOPE: the targeted path only. COMBAT creature-vs-creature damage
-- (resolve_combat_damage) is a later slice (mirrors how player damage went targeted
-- in mig 125 then combat in mig 127); protection already gates combat by colour. The
-- castable "prevent damage to target creature" card effect is also a follow-up (this
-- ships the resolver + helper + targeted wiring, like mig 125 preceded mig 126).
-- (IDE T-SQL false-positives on $$ bodies — ignore.)

-- ---------------------------------------------------------------------------
-- add_creature_damage_prevention — a shield protecting a CREATURE (affected_card_id).
-- ---------------------------------------------------------------------------
create or replace function public.add_creature_damage_prevention(
  p_session_id uuid,
  p_card_id uuid,
  p_amount integer default null,
  p_combat_only boolean default false,
  p_source_card_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_turn integer;
  v_id uuid;
begin
  select turn_number into v_turn
  from public.game_turn_state where session_id = p_session_id;

  insert into public.game_damage_prevention (
    session_id, affected_card_id, amount, combat_only, expires_turn, source_card_id
  )
  values (
    p_session_id, p_card_id,
    case when p_amount is null then null else greatest(0, p_amount) end,
    coalesce(p_combat_only, false), v_turn, p_source_card_id
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.add_creature_damage_prevention(uuid, uuid, integer, boolean, uuid) from public;
grant execute on function public.add_creature_damage_prevention(uuid, uuid, integer, boolean, uuid) to authenticated;
grant execute on function public.add_creature_damage_prevention(uuid, uuid, integer, boolean, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- apply_damage_to_creature — THE RESOLVER. Consume creature shields (oldest first),
-- then mark the remaining damage (carrying a deathtouch flag) and run the lethal
-- sweep. Returns the damage actually dealt. Mirrors apply_damage_to_player.
-- ---------------------------------------------------------------------------
create or replace function public.apply_damage_to_creature(
  p_session_id uuid,
  p_card_id uuid,
  p_amount integer,
  p_source_card_id uuid default null,
  p_is_combat boolean default false,
  p_deathtouch boolean default false
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
    update public.game_cards
    set damage_marked = damage_marked + v_remaining,
        dealt_deathtouch_damage = dealt_deathtouch_damage or coalesce(p_deathtouch, false)
    where id = p_card_id
      and session_id = p_session_id
      and zone = 'battlefield';

    perform public.move_lethal_damaged_creatures_to_graveyard(p_session_id);
  end if;

  return v_remaining;
end;
$$;

revoke all on function public.apply_damage_to_creature(uuid, uuid, integer, uuid, boolean, boolean) from public;
grant execute on function public.apply_damage_to_creature(uuid, uuid, integer, uuid, boolean, boolean) to authenticated;
grant execute on function public.apply_damage_to_creature(uuid, uuid, integer, uuid, boolean, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- apply_creature_effect — reproduced from mig 129; ONLY the deal_damage branch
-- changes (route through apply_damage_to_creature). Everything else is verbatim.
-- ---------------------------------------------------------------------------
create or replace function public.apply_creature_effect(
  p_session_id uuid,
  p_kind text,
  p_target_card_id uuid,
  p_params jsonb default '{}'::jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount integer := coalesce((p_params ->> 'amount')::integer, 0);
  v_target_owner_id uuid;
  v_next_position integer;
  v_keyword text;
  v_acting_controller uuid;
  v_duration text;
  v_prev_controller uuid;
begin
  if p_target_card_id is null then
    return;
  end if;

  if p_kind = 'deal_damage' then
    if v_amount > 0 then
      -- Routed through the prevention resolver (F2.1d) instead of marking inline.
      perform public.apply_damage_to_creature(
        p_session_id,
        p_target_card_id,
        v_amount,
        null,
        false,
        coalesce((p_params ->> 'deathtouch')::boolean, false)
      );
    end if;

  elsif p_kind = 'destroy' then
    perform public.put_in_graveyard(p_session_id, p_target_card_id);

  elsif p_kind = 'exile' then
    select owner_id
    into v_target_owner_id
    from public.game_cards
    where id = p_target_card_id
      and session_id = p_session_id
      and zone = 'battlefield';

    if found then
      select coalesce(max(zone_position), -1) + 1
      into v_next_position
      from public.game_cards
      where session_id = p_session_id
        and owner_id = v_target_owner_id
        and zone = 'exile';

      update public.game_cards
      set
        zone = 'exile',
        zone_position = v_next_position,
        controller_player_id = owner_id,
        is_tapped = false,
        damage_marked = 0,
        dealt_deathtouch_damage = false,
        plus_one_counters = 0
      where id = p_target_card_id;
    end if;

  elsif p_kind = 'bounce' then
    select owner_id
    into v_target_owner_id
    from public.game_cards
    where id = p_target_card_id
      and session_id = p_session_id
      and zone = 'battlefield';

    if found then
      select coalesce(max(zone_position), -1) + 1
      into v_next_position
      from public.game_cards
      where session_id = p_session_id
        and owner_id = v_target_owner_id
        and zone = 'hand';

      update public.game_cards
      set
        zone = 'hand',
        zone_position = v_next_position,
        controller_player_id = owner_id,
        is_tapped = false,
        damage_marked = 0,
        dealt_deathtouch_damage = false,
        plus_one_counters = 0
      where id = p_target_card_id;
    end if;

  elsif p_kind in ('tap', 'untap') then
    update public.game_cards
    set is_tapped = (p_kind = 'tap')
    where id = p_target_card_id
      and session_id = p_session_id
      and zone = 'battlefield';

  elsif p_kind = 'add_counters' then
    if v_amount > 0 then
      update public.game_cards
      set plus_one_counters = greatest(0, plus_one_counters + v_amount)
      where id = p_target_card_id
        and session_id = p_session_id
        and zone = 'battlefield';
    end if;

  elsif p_kind = 'pump' then
    if exists (
      select 1 from public.game_cards
      where id = p_target_card_id
        and session_id = p_session_id
        and zone = 'battlefield'
    ) then
      perform public.create_pt_pump(
        p_session_id,
        p_target_card_id,
        coalesce((p_params ->> 'power')::integer, 0),
        coalesce((p_params ->> 'toughness')::integer, 0)
      );
    end if;

  elsif p_kind = 'set_pt' then
    if exists (
      select 1 from public.game_cards
      where id = p_target_card_id
        and session_id = p_session_id
        and zone = 'battlefield'
    ) then
      insert into public.game_continuous_effects (
        session_id, source_card_id, affected_card_id, effect_type, payload,
        source_zone_required, expires_at_phase, expires_at_step
      )
      values (
        p_session_id, p_target_card_id, p_target_card_id, 'set_pt',
        jsonb_build_object(
          'power', coalesce((p_params ->> 'power')::integer, 0),
          'toughness', coalesce((p_params ->> 'toughness')::integer, 0),
          'until_end_of_turn', true
        ),
        'battlefield', 'ending', 'cleanup'
      );
    end if;

  elsif p_kind = 'grant_keyword' then
    v_keyword := lower(coalesce(p_params ->> 'keyword', ''));

    if v_keyword not in (
      'flying', 'reach', 'trample', 'vigilance', 'haste',
      'first_strike', 'double_strike', 'deathtouch', 'indestructible'
    ) then
      raise exception 'Unsupported keyword grant: %', v_keyword;
    end if;

    if exists (
      select 1 from public.game_cards
      where id = p_target_card_id
        and session_id = p_session_id
        and zone = 'battlefield'
    ) then
      insert into public.game_continuous_effects (
        session_id,
        source_card_id,
        affected_card_id,
        effect_type,
        payload,
        source_zone_required,
        expires_at_phase,
        expires_at_step
      )
      values (
        p_session_id,
        p_target_card_id,
        p_target_card_id,
        v_keyword,
        jsonb_build_object('until_end_of_turn', true),
        'battlefield',
        'ending',
        'cleanup'
      );
    end if;

  elsif p_kind = 'gain_control' then
    v_acting_controller := nullif(p_params ->> 'acting_controller', '')::uuid;
    if v_acting_controller is null then
      raise exception 'gain_control requires an acting controller';
    end if;

    v_duration := lower(coalesce(p_params ->> 'duration', 'permanent'));
    if v_duration not in ('permanent', 'end_of_turn') then
      raise exception 'Unsupported gain_control duration: %', v_duration;
    end if;

    select controller_player_id
    into v_prev_controller
    from public.game_cards
    where id = p_target_card_id
      and session_id = p_session_id
      and zone = 'battlefield';

    if found then
      update public.game_cards
      set
        controller_player_id = v_acting_controller,
        is_tapped = case when coalesce((p_params ->> 'untap')::boolean, false) then false else is_tapped end
      where id = p_target_card_id;

      if coalesce((p_params ->> 'haste')::boolean, false) then
        insert into public.game_continuous_effects (
          session_id, source_card_id, affected_card_id, effect_type, payload,
          source_zone_required, expires_at_phase, expires_at_step
        )
        values (
          p_session_id, p_target_card_id, p_target_card_id, 'haste',
          jsonb_build_object('until_end_of_turn', true),
          'battlefield', 'ending', 'cleanup'
        );
      end if;

      if v_duration = 'end_of_turn' then
        insert into public.game_continuous_effects (
          session_id, source_card_id, affected_card_id, effect_type, payload,
          source_zone_required, expires_at_phase, expires_at_step
        )
        values (
          p_session_id, p_target_card_id, p_target_card_id, 'control',
          jsonb_build_object('original_controller', v_prev_controller),
          'battlefield', 'ending', 'cleanup'
        );
      end if;
    end if;

  else
    raise exception 'Unsupported creature effect kind: %', p_kind;
  end if;
end;
$$;

grant execute on function public.apply_creature_effect(uuid, text, uuid, jsonb) to authenticated;
