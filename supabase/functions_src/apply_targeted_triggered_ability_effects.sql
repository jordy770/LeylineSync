-- supabase/functions_src/apply_targeted_triggered_ability_effects.sql
-- CANONICAL current definition (seeded from 202605010114_permanent_trigger_targets.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

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
    if public.trigger_effect_target_type(v_effect) is null then
      perform public.apply_triggered_ability_effects(
        p_session_id, p_controller_id, p_source_card_id, jsonb_build_array(v_effect)
      );
      continue;
    end if;

    -- Targeted trigger effects fizzle harmlessly if the target is gone; the
    -- primitive re-checks the target is on the battlefield per mutation.
    v_eff_type := lower(coalesce(v_effect ->> 'type', ''));

    if v_eff_type = 'fight' then
      perform public.apply_fight(p_session_id, p_source_card_id, p_target_card_id);
    else
      -- acting_source (mig 246): the trigger's SOURCE permanent, for effects
      -- whose lifetime is tied to it (gain_control duration 'while_source').
      perform public.apply_creature_effect(
        p_session_id, v_eff_type, p_target_card_id,
        v_effect || jsonb_build_object(
          'acting_controller', p_controller_id,
          'acting_source', p_source_card_id)
      );
    end if;
  end loop;
end;
$$;
grant execute on function public.apply_targeted_triggered_ability_effects(uuid, uuid, uuid, jsonb, uuid) to authenticated;
