-- Phase 3, slice 1 — general multi-target (removal family): destroy / exile /
-- bounce / tap / untap of up to N target creatures ("destroy two target
-- creatures", Cone of Cold). The first effect with an arbitrary-length target set.
--
-- Mechanism — one NEW castable action type `multi_creature_effect` (the existing
-- single-target action types are UNTOUCHED, so destroy_creature et al. keep their
-- exact behaviour and tests). Its payload carries `kind` (the removal kind) plus a
-- `target_card_ids` ARRAY. It plugs into the data-driven dispatch from mig 104/105
-- with ZERO reproduction of put_action_on_stack / resolve_top_of_stack:
--   * builder  build_stack_payload_multi_creature_simple — validates `kind` and
--     that EVERY id in target_card_ids is a legal creature for the spell (same
--     creature_target_controller_ok gate the single-target builders use). Targets
--     are locked at cast, as in MTG.
--   * handler  handle_multi_creature_effect — loops apply_creature_effect(kind, id)
--     over the array. apply_creature_effect already no-ops a target that has left
--     the battlefield, so a partially-illegal set still resolves for the legal ones
--     (rule 608.2b/c: resolve for all targets still legal).
--
-- The "up to N" cap is the authoring/client contract (the picker offers up to N);
-- the server only enforces that whatever set is submitted are all legal creatures.
-- (IDE T-SQL false-positives on $$ bodies — ignore.)

-- ---------------------------------------------------------------------------
-- Allow the new action type on the stack (reproduces the mig 107 allow-list + 1).
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
    'multi_creature_effect'
  ]));

-- ---------------------------------------------------------------------------
-- Builder: validate kind + an array of legal creature targets.
-- ---------------------------------------------------------------------------
create or replace function public.build_stack_payload_multi_creature_simple(
  p_session_id uuid, p_actor uuid, p_payload jsonb, p_timing text, p_target_controller text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_kind text;
  v_ids uuid[];
  v_id uuid;
begin
  v_kind := lower(coalesce(p_payload ->> 'kind', ''));
  if v_kind not in ('destroy', 'exile', 'bounce', 'tap', 'untap') then
    raise exception 'Unsupported multi-target effect kind: %', v_kind;
  end if;

  -- Distinct targets from the submitted array.
  select array_agg(distinct (value)::uuid)
  into v_ids
  from jsonb_array_elements_text(
    case when jsonb_typeof(p_payload -> 'target_card_ids') = 'array'
         then p_payload -> 'target_card_ids' else '[]'::jsonb end
  );

  if coalesce(array_length(v_ids, 1), 0) = 0 then
    raise exception 'target_card_ids must contain at least one target';
  end if;

  -- Every target must be a legal creature for this spell (battlefield + controller
  -- restriction), exactly as the single-target builders require.
  foreach v_id in array v_ids loop
    if not public.creature_target_controller_ok(p_session_id, v_id, p_actor, p_target_controller) then
      raise exception 'Target is not a legal creature for this spell';
    end if;
  end loop;

  return jsonb_build_object(
    'kind', v_kind,
    'target_card_ids', to_jsonb(v_ids),
    'target_controller', p_target_controller,
    'timing', p_timing
  );
end;
$$;

revoke all on function public.build_stack_payload_multi_creature_simple(uuid, uuid, jsonb, text, text) from public;

-- ---------------------------------------------------------------------------
-- Handler: apply the kind to each target. apply_creature_effect no-ops a target
-- that is no longer on the battlefield, so the spell resolves for legal targets.
-- ---------------------------------------------------------------------------
create or replace function public.handle_multi_creature_effect(
  p_session_id uuid,
  p_stack_item public.game_stack_items
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text := lower(coalesce(p_stack_item.payload ->> 'kind', ''));
  v_id uuid;
begin
  for v_id in
    select (value)::uuid
    from jsonb_array_elements_text(
      case when jsonb_typeof(p_stack_item.payload -> 'target_card_ids') = 'array'
           then p_stack_item.payload -> 'target_card_ids' else '[]'::jsonb end
    )
  loop
    perform public.apply_creature_effect(p_session_id, v_kind, v_id, p_stack_item.payload);
  end loop;
  return null;
end;
$$;

revoke all on function public.handle_multi_creature_effect(uuid, public.game_stack_items) from public;

-- ---------------------------------------------------------------------------
-- Register the action type (idempotent). handler_fn + builder_fn both set.
-- ---------------------------------------------------------------------------
insert into public.stack_action_handlers (action_type, handler_fn, builder_fn, description) values
  ('multi_creature_effect', 'handle_multi_creature_effect', 'build_stack_payload_multi_creature_simple',
   'Apply a removal effect (destroy/exile/bounce/tap/untap) to up to N target creatures')
on conflict (action_type) do update
  set handler_fn = excluded.handler_fn,
      builder_fn = excluded.builder_fn,
      description = excluded.description;
