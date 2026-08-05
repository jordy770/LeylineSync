-- supabase/functions_src/build_stack_payload_add_counters_creature.sql
-- CANONICAL current definition (seeded from 202605010162_dynamic_amounts_spells_abilities.sql
-- for mig 439). Edit THIS file, then generate a migration with
-- scripts/new-migration.mjs — never re-extract from past migrations.

create or replace function public.build_stack_payload_add_counters_creature(
  p_session_id uuid, p_actor uuid, p_payload jsonb, p_timing text, p_target_controller text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_target_card_id uuid;
  v_amount integer;
  v_all boolean;
begin
  v_target_card_id := nullif(p_payload ->> 'target_card_id', '')::uuid;
  if jsonb_typeof(p_payload -> 'amount') = 'object' then
    v_amount := public.resolve_dynamic_amount(p_session_id, null, p_actor, p_payload -> 'amount', v_target_card_id);
  else
    v_amount := coalesce((p_payload ->> 'amount')::integer, 0);
  end if;
  v_all := coalesce((p_payload ->> 'all')::boolean, false);

  if v_target_card_id is null then
    raise exception 'target_card_id is required';
  end if;
  if v_amount = 0 and not v_all then
    raise exception 'amount must be non-zero (or all=true to remove every counter)';
  end if;
  if not public.creature_target_controller_ok(p_session_id, v_target_card_id, p_actor, p_target_controller) then
    raise exception 'Target is not a legal creature for this spell';
  end if;

  return jsonb_build_object(
    'target_card_id', v_target_card_id,
    'amount', v_amount,
    'all', v_all,
    'counter_type', p_payload ->> 'counter_type',
    'target_controller', p_target_controller,
    'timing', p_timing
  )
  -- if_target_type_line (mig 439, Sorin's Vampire rider): ride the built
  -- payload through to apply_creature_effect, which enforces the gate.
  || (case when nullif(p_payload ->> 'if_target_type_line', '') is not null
           then jsonb_build_object('if_target_type_line', p_payload ->> 'if_target_type_line')
           else '{}'::jsonb end);
end;
$$;
