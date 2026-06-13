-- supabase/functions_src/trigger_effect_target_type.sql
-- CANONICAL current definition (seeded from 202605010172_dynamic_pump_loyalty_target.sql;
-- first edited in mig 242). Edit THIS file, then generate a migration with
-- scripts/new-migration.mjs — never re-extract from past migrations.

-- Which target kind a trigger/spell program effect wants, or null for
-- untargeted. mig 242 adds shuffle_into_library to the permanent-targeted
-- removal family (Chaos Warp).
create or replace function public.trigger_effect_target_type(p_effect jsonb)
returns jsonb language sql immutable as $$
  select case
    when lower(coalesce(p_effect ->> 'type', '')) in
         ('deal_damage', 'destroy', 'exile', 'bounce', 'tap', 'untap',
          'add_counters', 'grant_keyword', 'fight', 'gain_control', 'set_pt', 'pump', 'goad',
          'exile_and_manifest', 'ignition', 'exile_until_leaves')
         and public.behavior_target_type_is_creature_only(p_effect -> 'target_type')
      then '"creature"'::jsonb
    when lower(coalesce(p_effect ->> 'type', '')) in
         ('destroy', 'exile', 'bounce', 'tap', 'untap', 'shuffle_into_library', 'gain_control',
          'exile_until_leaves', 'animate', 'add_counters')
         and public.behavior_target_type_is_permanent_only(p_effect -> 'target_type')
      then p_effect -> 'target_type'
    else null
  end;
$$;
grant all on function public.trigger_effect_target_type(jsonb) to anon, authenticated, service_role;
