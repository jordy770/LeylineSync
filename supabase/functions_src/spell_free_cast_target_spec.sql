-- supabase/functions_src/spell_free_cast_target_spec.sql
-- CANONICAL current definition.
-- Reads a spell's cast-time target requirement by REUSING the trigger-effect target
-- extractors (a spell's effect actions share the trigger-effect action shape). Returns
-- {required, target_type, target_controller, target_count}. required=false → no cast-time
-- target (the free-caster casts it straight away). Written for cascade / generalized
-- nested-cast (design doc: 2026-07-20-cascade-nested-cast-design.md).
create or replace function public.spell_free_cast_target_spec(p_actions jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_tt jsonb;
begin
  if p_actions is null or jsonb_typeof(p_actions) <> 'array' then
    return jsonb_build_object('required', false);
  end if;
  v_tt := public.trigger_effects_target_type(p_actions);
  if v_tt is null then
    return jsonb_build_object('required', false);
  end if;
  return jsonb_build_object(
    'required', true,
    'target_type', v_tt,
    'target_controller', coalesce(public.trigger_effects_target_controller(p_actions), 'any'),
    'target_count', coalesce(public.trigger_effects_target_count(p_actions), 1));
end;
$$;
grant execute on function public.spell_free_cast_target_spec(jsonb) to authenticated;
