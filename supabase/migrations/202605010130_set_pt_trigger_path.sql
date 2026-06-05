-- Phase 4 / F2.2c — set_pt on the TRIGGER path ("when ~ enters, target creature
-- becomes a 0/1 until end of turn").
--
-- The whole announcement-time trigger-target machinery (enqueue → pick → fizzle →
-- dispatch) is driven off trigger_effect_target_type: an effect that returns a
-- target_type is enqueued requiring a target, the picker validates it, and
-- apply_targeted_triggered_ability_effects dispatches it to apply_creature_effect.
-- apply_creature_effect already has the set_pt kind (mig 129), so the ONLY change
-- needed is teaching trigger_effect_target_type that set_pt is creature-targeting.
--
-- Reproduces trigger_effect_target_type from CURRENT (mig 114) verbatim except the
-- added 'set_pt' in the creature-target list. (IDE T-SQL false-positives on $$.)

create or replace function public.trigger_effect_target_type(p_effect jsonb)
returns jsonb language sql immutable as $$
  select case
    when lower(coalesce(p_effect ->> 'type', '')) in
         ('deal_damage', 'destroy', 'exile', 'bounce', 'tap', 'untap',
          'add_counters', 'grant_keyword', 'fight', 'gain_control', 'set_pt')
         and public.behavior_target_type_is_creature_only(p_effect -> 'target_type')
      then '"creature"'::jsonb
    when lower(coalesce(p_effect ->> 'type', '')) in ('destroy', 'exile', 'bounce', 'tap', 'untap')
         and public.behavior_target_type_is_permanent_only(p_effect -> 'target_type')
      then p_effect -> 'target_type'
    else null
  end;
$$;

grant all on function public.trigger_effect_target_type(jsonb) to anon, authenticated, service_role;
