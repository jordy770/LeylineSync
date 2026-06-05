-- Tier-2 effect: gain_control (Threaten / Mind Control) — TRIGGER path.
--
-- "When this enters, gain control of target creature you don't control [until end
-- of turn]." The ability's controller takes control of the picked creature.
-- Unlike keyword/pump (which are READ THROUGH from game_continuous_effects by the
-- card_has_*/card_effective_power accessors), control is a DIRECT column
-- (game_cards.controller_player_id). So:
--   * permanent control  = a direct UPDATE of controller_player_id.
--   * until-end-of-turn   = the same UPDATE, plus a 'control' continuous-effect row
--                           carrying the ORIGINAL controller; the cleanup sweep
--                           (expire_continuous_effects_for_step) restores it before
--                           deleting the row. (The generic sweep only DELETEs, so a
--                           direct-mutation effect like control needs an explicit
--                           revert there — added below.)
--
-- Threading the acting controller: apply_creature_effect has no controller param
-- (it only gets session/kind/target/params). Rather than change its signature, the
-- trigger dispatcher (apply_targeted_triggered_ability_effects) now injects
-- `acting_controller` into the effect params it passes down — behavior-neutral for
-- every other creature kind (they ignore it).
--
-- Scope: TRIGGER path only (mirrors how grant_keyword shipped, mig 099). The
-- spell/instant path and the "threaten" combat extras (untap + haste so the stolen
-- creature can attack) are deferred follow-ups. (IDE T-SQL false-positives on $$
-- bodies — ignore.)

-- 1) 'control' becomes a valid continuous-effect type (carries the original
-- controller for the until-EOT revert).
alter table public.game_continuous_effects
  drop constraint if exists game_continuous_effects_effect_type_check;
alter table public.game_continuous_effects
  add constraint game_continuous_effects_effect_type_check
  check (effect_type = any (array[
    'mana_does_not_empty', 'additional_land_plays', 'haste', 'vigilance',
    'indestructible', 'trample', 'first_strike', 'double_strike', 'flying',
    'reach', 'deathtouch', 'pump', 'control'
  ]));

-- 2) apply_creature_effect: add the gain_control kind. Reproduced from mig 103;
-- the only change is the new branch (and its declared vars).
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
    -- Who gains control (threaded in by the dispatcher).
    v_acting_controller := nullif(p_params ->> 'acting_controller', '')::uuid;
    if v_acting_controller is null then
      raise exception 'gain_control requires an acting controller';
    end if;

    v_duration := lower(coalesce(p_params ->> 'duration', 'permanent'));
    if v_duration not in ('permanent', 'end_of_turn') then
      raise exception 'Unsupported gain_control duration: %', v_duration;
    end if;

    -- Capture the current controller (for the until-EOT revert); act only on a
    -- creature still on the battlefield.
    select controller_player_id
    into v_prev_controller
    from public.game_cards
    where id = p_target_card_id
      and session_id = p_session_id
      and zone = 'battlefield';

    if found then
      update public.game_cards
      set controller_player_id = v_acting_controller
      where id = p_target_card_id;

      if v_duration = 'end_of_turn' then
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
          'control',
          jsonb_build_object('original_controller', v_prev_controller),
          'battlefield',
          'ending',
          'cleanup'
        );
      end if;
    end if;

  else
    raise exception 'Unsupported creature effect kind: %', p_kind;
  end if;
end;
$$;

grant execute on function public.apply_creature_effect(uuid, text, uuid, jsonb) to authenticated;

-- 3) Route gain_control through the targeted-trigger creature picker (reproduced
-- from mig 102 with 'gain_control' added).
create or replace function public.trigger_effect_requires_creature_target(p_effect jsonb)
returns boolean
language sql
immutable
as $$
  select
    lower(coalesce(p_effect ->> 'type', '')) in (
      'deal_damage',
      'destroy',
      'exile',
      'bounce',
      'tap',
      'untap',
      'add_counters',
      'grant_keyword',
      'fight',
      'gain_control'
    )
    and public.behavior_target_type_is_creature_only(p_effect -> 'target_type');
$$;

-- 4) Inject the acting controller into the effect params for the creature-effect
-- dispatch, so gain_control knows who gains control. Behavior-neutral for every
-- other kind (they ignore acting_controller). Reproduced from mig 102.
create or replace function public.apply_targeted_triggered_ability_effects(
  p_session_id uuid,
  p_controller_id uuid,
  p_source_card_id uuid,
  p_effects jsonb,
  p_target_card_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_effect jsonb;
  v_eff_type text;
begin
  for v_effect in
    select * from jsonb_array_elements(coalesce(p_effects, '[]'::jsonb))
  loop
    if not public.trigger_effect_requires_creature_target(v_effect) then
      perform public.apply_triggered_ability_effects(
        p_session_id,
        p_controller_id,
        p_source_card_id,
        jsonb_build_array(v_effect)
      );
      continue;
    end if;

    -- Targeted trigger effects fizzle harmlessly if the target is gone; the
    -- primitive re-checks the target is on the battlefield per mutation.
    v_eff_type := lower(coalesce(v_effect ->> 'type', ''));

    if v_eff_type = 'fight' then
      -- The source creature fights the picked target creature.
      perform public.apply_fight(p_session_id, p_source_card_id, p_target_card_id);
    else
      perform public.apply_creature_effect(
        p_session_id,
        v_eff_type,
        p_target_card_id,
        v_effect || jsonb_build_object('acting_controller', p_controller_id)
      );
    end if;
  end loop;
end;
$$;

grant execute on function public.apply_targeted_triggered_ability_effects(uuid, uuid, uuid, jsonb, uuid) to authenticated;

-- 5) Cleanup sweep restores original control for expiring 'control' effects BEFORE
-- deleting them (control is a direct column, not a read-through layer). Reproduced
-- from the baseline expire_continuous_effects_for_step + the restore step.
create or replace function public.expire_continuous_effects_for_step(
  p_session_id uuid,
  p_turn_number integer,
  p_phase text,
  p_step text
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  -- Restore control for any 'control' effects about to expire (same predicate as
  -- the delete below), but only for creatures still on the battlefield — a
  -- creature that left already had its controller reset on the zone change.
  update public.game_cards gc
  set controller_player_id = nullif(ce.payload ->> 'original_controller', '')::uuid
  from public.game_continuous_effects ce
  where ce.session_id = p_session_id
    and ce.effect_type = 'control'
    and ce.affected_card_id = gc.id
    and gc.session_id = p_session_id
    and gc.zone = 'battlefield'
    and nullif(ce.payload ->> 'original_controller', '')::uuid is not null
    and (
      (ce.expires_at_turn_number is not null and ce.expires_at_turn_number < p_turn_number)
      or (
        ce.expires_at_phase = p_phase
        and (ce.expires_at_step is null or ce.expires_at_step = p_step)
      )
    );

  delete from public.game_continuous_effects
  where session_id = p_session_id
    and (
      (expires_at_turn_number is not null and expires_at_turn_number < p_turn_number)
      or (
        expires_at_phase = p_phase
        and (expires_at_step is null or expires_at_step = p_step)
      )
    );

  get diagnostics v_deleted_count = row_count;

  return v_deleted_count;
end;
$$;

grant execute on function public.expire_continuous_effects_for_step(uuid, integer, text, text) to authenticated;
