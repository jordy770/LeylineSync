-- Tier-2 effect: fight — TRIGGER path ("when this enters, it fights target
-- creature"). The spell path shipped in mig 101 (cast_fight). This wires fight
-- into the existing targeted-trigger machinery so the SOURCE creature (the one
-- with the ability) is the fighter and the player picks the FOUGHT creature
-- through the standard trigger target picker. No new client UI: the same
-- choose_triggered_ability_creature_target flow that destroy/exile/grant_keyword
-- triggers already use.
--
-- Two seams, both already built for grant_keyword (mig 099):
--   1. trigger_effect_requires_creature_target learns 'fight', so when a trigger
--      with a fight effect is enqueued, trigger_effects_require_creature_target
--      marks it target_required and trigger_effects_target_controller pulls the
--      effect's target_controller (the FOUGHT creature's restriction).
--   2. apply_targeted_triggered_ability_effects dispatches a 'fight' effect to
--      apply_fight(session, SOURCE, TARGET) — source is the fighter, the picked
--      target is the fought creature — instead of apply_creature_effect (which
--      has no 'fight' kind).
--
-- apply_fight also gains a self-fight guard: the trigger picker constrains the
-- fought creature by controller but does not exclude the source, so guard here
-- (cast_fight already raised on self-fight before reaching apply_fight).
-- (IDE T-SQL false-positives on $$ bodies — ignore.)

-- 1) apply_fight: reproduced from mig 101 with a self-fight no-op guard.
create or replace function public.apply_fight(
  p_session_id uuid,
  p_fighter_card_id uuid,
  p_fought_card_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_power_fighter integer;
  v_power_fought integer;
begin
  if p_fighter_card_id is null or p_fought_card_id is null then
    return;
  end if;

  -- A creature can't fight itself (CR: fight needs two creatures). Fizzle.
  if p_fighter_card_id = p_fought_card_id then
    return;
  end if;

  -- Both must still be creatures on the battlefield; otherwise neither fights.
  if not exists (
    select 1 from public.game_cards
    where id = p_fighter_card_id and session_id = p_session_id and zone = 'battlefield'
  ) or not exists (
    select 1 from public.game_cards
    where id = p_fought_card_id and session_id = p_session_id and zone = 'battlefield'
  ) then
    return;
  end if;

  v_power_fighter := greatest(coalesce(public.card_effective_power(p_session_id, p_fighter_card_id), 0), 0);
  v_power_fought  := greatest(coalesce(public.card_effective_power(p_session_id, p_fought_card_id), 0), 0);

  -- Each deals its power to the other (apply_creature_effect re-runs lethal SBAs;
  -- amount 0 is a harmless no-op).
  perform public.apply_creature_effect(
    p_session_id, 'deal_damage', p_fought_card_id,
    jsonb_build_object('amount', v_power_fighter)
  );
  perform public.apply_creature_effect(
    p_session_id, 'deal_damage', p_fighter_card_id,
    jsonb_build_object('amount', v_power_fought)
  );
end;
$$;

grant execute on function public.apply_fight(uuid, uuid, uuid) to authenticated;

-- 2) fight is a creature-targeting effect: route it through the targeted-trigger
-- picker (reproduced from mig 099 + 'fight').
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
      'fight'
    )
    and public.behavior_target_type_is_creature_only(p_effect -> 'target_type');
$$;

-- 3) Dispatch a 'fight' trigger effect to apply_fight(session, SOURCE, TARGET):
-- the ability's source creature is the fighter, the picked creature is fought.
-- Every other creature-target effect still routes to apply_creature_effect.
-- (Reproduced from mig 099 with the fight branch.)
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
        v_effect
      );
    end if;
  end loop;
end;
$$;

grant execute on function public.apply_targeted_triggered_ability_effects(uuid, uuid, uuid, jsonb, uuid) to authenticated;
