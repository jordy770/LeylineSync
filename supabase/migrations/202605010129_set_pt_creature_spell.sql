-- Phase 4 / F2.2b — "becomes X/Y until end of turn": a targeted set_pt creature
-- effect (Turn to Frog / Ovinize). Builds on F2.2a's set_pt layer (mig 128) and
-- the data-driven stack-action registry (mig 104/105).
--
-- A spell sets a target creature's base power/toughness until end of turn by
-- inserting an until-EOT `set_pt` continuous effect (exactly the grant_keyword /
-- haste pattern). The continuous accessors already layer it correctly (7b).
--
-- SEAMS: (1) apply_creature_effect gains a `set_pt` kind — reproduced from CURRENT
-- (mig 107) verbatim + the new branch; (2) a builder + registry row + action_type
-- CHECK value add the `set_pt_creature` stack action so put_action_on_stack can
-- cast it. The trigger path (apply_targeted_triggered_ability_effects) and the
-- client getSpellPlan routing are follow-ups; this is harness-tested via the
-- registry path directly. (IDE T-SQL false-positives on $$ — ignore.)

-- ---------------------------------------------------------------------------
-- 1. apply_creature_effect + set_pt. Verbatim from mig 107 except the new branch.
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
      update public.game_cards
      set damage_marked = damage_marked + v_amount,
          dealt_deathtouch_damage = dealt_deathtouch_damage
            or coalesce((p_params ->> 'deathtouch')::boolean, false)
      where id = p_target_card_id
        and session_id = p_session_id
        and zone = 'battlefield';

      perform public.move_lethal_damaged_creatures_to_graveyard(p_session_id);
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
    -- "Becomes X/Y until end of turn": an until-EOT set_pt effect (layer 7b).
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

-- ---------------------------------------------------------------------------
-- 2. Builder for the set_pt_creature stack action.
-- ---------------------------------------------------------------------------
create or replace function public.build_stack_payload_set_pt_creature(
  p_session_id uuid, p_actor uuid, p_payload jsonb, p_timing text, p_target_controller text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_target_card_id uuid;
begin
  v_target_card_id := nullif(p_payload ->> 'target_card_id', '')::uuid;

  if v_target_card_id is null then
    raise exception 'target_card_id is required';
  end if;
  if not public.creature_target_controller_ok(p_session_id, v_target_card_id, p_actor, p_target_controller) then
    raise exception 'Target is not a legal creature for this spell';
  end if;

  return jsonb_build_object(
    'target_card_id', v_target_card_id,
    'power', coalesce((p_payload ->> 'power')::integer, 0),
    'toughness', coalesce((p_payload ->> 'toughness')::integer, 0),
    'target_controller', p_target_controller,
    'timing', p_timing
  );
end;
$$;

revoke all on function public.build_stack_payload_set_pt_creature(uuid, uuid, jsonb, text, text) from public;

-- ---------------------------------------------------------------------------
-- 3. Allow the new action type, then register it (handle_creature_effect strips
-- "_creature" → apply_creature_effect('set_pt', ...)). CHECK list = mig 115 + new.
-- ---------------------------------------------------------------------------
alter table public.game_stack_items
  drop constraint if exists game_stack_items_action_type_check;
alter table public.game_stack_items
  add constraint game_stack_items_action_type_check
  check (action_type = any (array[
    'deal_damage_player', 'deal_damage_creature', 'pump_creature', 'cast_permanent',
    'counter_spell', 'triggered_ability', 'draw_cards', 'destroy_creature',
    'bounce_creature', 'tap_creature', 'untap_creature', 'add_counters_creature',
    'exile_creature', 'grant_keyword_creature', 'gain_control_creature',
    'fight_creatures', 'modal_spell', 'scry', 'surveil', 'spell_effect',
    'multi_creature_effect', 'permanent_effect', 'divided_damage', 'set_pt_creature'
  ]));

insert into public.stack_action_handlers (action_type, handler_fn, builder_fn, description) values
  ('set_pt_creature', 'handle_creature_effect', 'build_stack_payload_set_pt_creature',
   'Set a creature''s base power/toughness until end of turn')
on conflict (action_type) do update
  set handler_fn = excluded.handler_fn,
      builder_fn = excluded.builder_fn,
      description = excluded.description;
