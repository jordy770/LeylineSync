-- Tier-2 effect: grant_keyword — give a target creature a keyword until end of
-- turn. Modeled exactly like create_pt_pump's until-end-of-turn row: it inserts
-- a game_continuous_effects row (effect_type = the keyword) that the existing
-- card_has_<keyword> accessors already read, and that the existing
-- expire_continuous_effects_for_step sweep removes at end-of-turn cleanup.
--
-- The keyword names are all already members of the game_continuous_effects
-- effect_type CHECK constraint, so no constraint change is needed.
--
-- Scope: enabled as a TARGETED TRIGGER effect (e.g. "When this enters, target
-- creature you control gains flying until end of turn"). The instant/combat-trick
-- spell path (a grant_keyword_creature stack action + client picker) is a
-- separate follow-up, mirroring how mill shipped trigger-first.

-- 1) The shared creature primitive learns the grant_keyword kind.
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
begin
  if p_target_card_id is null then
    return;
  end if;

  if p_kind = 'deal_damage' then
    if v_amount > 0 then
      update public.game_cards
      set damage_marked = damage_marked + v_amount
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

    -- Only grant to a creature still on the battlefield (fizzles otherwise).
    -- source_card_id = the target so source_zone_required = 'battlefield' makes
    -- the grant lapse if the creature leaves; the ending/cleanup expiry removes
    -- it at end of turn (identical to create_pt_pump's until-EOT row).
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

  else
    raise exception 'Unsupported creature effect kind: %', p_kind;
  end if;
end;
$$;

grant execute on function public.apply_creature_effect(uuid, text, uuid, jsonb) to authenticated;

-- 2) Pass the WHOLE effect to apply_creature_effect so non-amount params
-- (keyword, and any future ones) survive. Behavior-preserving for the existing
-- targeted kinds, which only read 'amount' from the params jsonb.
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

    perform public.apply_creature_effect(
      p_session_id,
      v_eff_type,
      p_target_card_id,
      v_effect
    );
  end loop;
end;
$$;

grant execute on function public.apply_targeted_triggered_ability_effects(uuid, uuid, uuid, jsonb, uuid) to authenticated;

-- 3) grant_keyword is a creature-targeting effect: requires a creature-only
-- target_type, so it routes through the targeted-trigger picker.
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
      'grant_keyword'
    )
    and public.behavior_target_type_is_creature_only(p_effect -> 'target_type');
$$;
