-- Phase 3, slice 2 — targeting reach: NON-CREATURE PERMANENT targets. destroy /
-- exile / bounce / tap / untap a target artifact / enchantment / land /
-- planeswalker / "permanent" (Disenchant, Naturalize, Vindicate, Beast Within).
--
-- Key realisation: apply_creature_effect's removal kinds already operate on ANY
-- card on the battlefield (they never check type_line='creature') — so the engine
-- APPLY path needs no change. The only creature-only gates are the VALIDATOR
-- (creature_target_controller_ok hardcodes '%creature%') and the client picker.
--
-- Mechanism — ONE new castable action type `permanent_effect` (single target,
-- type-flexible), parallel to mig 112's multi_creature_effect and plugged into the
-- mig 104/105 data-driven dispatch (1 builder + 1 handler + 1 registry row). The
-- creature-only single-target action types (destroy_creature …) are UNTOUCHED.
--   * builder validates the target is a battlefield permanent whose type_line
--     matches the effect's target_type (a new type-aware validator), with the same
--     controller restriction the creature validator applies.
--   * handler calls apply_creature_effect(kind, id) — works on any permanent.
-- (IDE T-SQL false-positives on $$ bodies — ignore.)

-- ---------------------------------------------------------------------------
-- Type matcher: does a card's type_line satisfy an effect's target_type filter?
-- 'permanent'/'any' match anything on the battlefield (it is a permanent by
-- definition); a concrete type ('artifact', 'enchantment', 'land', 'creature',
-- 'planeswalker', 'battle') matches by type_line substring. target_type may be a
-- jsonb string or array; an array matches if ANY of its types match.
-- ---------------------------------------------------------------------------
create or replace function public.card_type_line_matches_target(
  p_type_line text, p_target_type jsonb
) returns boolean
language sql immutable
as $$
  select case
    when p_target_type is null then true  -- no restriction = any permanent
    else exists (
      select 1
      from jsonb_array_elements_text(
        case when jsonb_typeof(p_target_type) = 'array' then p_target_type
             else jsonb_build_array(trim(both '"' from p_target_type::text)) end
      ) as t(value)
      where lower(t.value) in ('any', 'permanent')
         or coalesce(p_type_line, '') ilike '%' || lower(t.value) || '%'
    )
  end;
$$;

grant all on function public.card_type_line_matches_target(text, jsonb) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Permanent target validator: battlefield + type_line match + controller
-- restriction. The non-creature analogue of creature_target_controller_ok.
-- ---------------------------------------------------------------------------
create or replace function public.permanent_target_controller_ok(
  p_session_id uuid, p_target_card_id uuid, p_controller_id uuid,
  p_target_controller text, p_target_type jsonb
) returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.game_cards gc
    join public.cards c on c.id = gc.card_id
    where gc.id = p_target_card_id
      and gc.session_id = p_session_id
      and gc.zone = 'battlefield'
      and public.card_type_line_matches_target(c.type_line, p_target_type)
      and (
        coalesce(p_target_controller, 'any') = 'any'
        or (p_target_controller = 'opponent' and gc.controller_player_id is distinct from p_controller_id)
        or (p_target_controller = 'you' and gc.controller_player_id = p_controller_id)
      )
  );
$$;

grant all on function public.permanent_target_controller_ok(uuid, uuid, uuid, text, jsonb) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Builder: validate kind + a single legal permanent target of the requested type.
-- ---------------------------------------------------------------------------
create or replace function public.build_stack_payload_permanent_simple(
  p_session_id uuid, p_actor uuid, p_payload jsonb, p_timing text, p_target_controller text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_kind text;
  v_target_card_id uuid;
  v_target_type jsonb;
begin
  v_kind := lower(coalesce(p_payload ->> 'kind', ''));
  if v_kind not in ('destroy', 'exile', 'bounce', 'tap', 'untap') then
    raise exception 'Unsupported permanent effect kind: %', v_kind;
  end if;

  v_target_card_id := nullif(p_payload ->> 'target_card_id', '')::uuid;
  if v_target_card_id is null then
    raise exception 'target_card_id is required';
  end if;

  -- Default to any permanent when target_type is omitted.
  v_target_type := coalesce(p_payload -> 'target_type', '"permanent"'::jsonb);

  if not public.permanent_target_controller_ok(p_session_id, v_target_card_id, p_actor, p_target_controller, v_target_type) then
    raise exception 'Target is not a legal permanent for this spell';
  end if;

  return jsonb_build_object(
    'kind', v_kind,
    'target_card_id', v_target_card_id,
    'target_type', v_target_type,
    'target_controller', p_target_controller,
    'timing', p_timing
  );
end;
$$;

revoke all on function public.build_stack_payload_permanent_simple(uuid, uuid, jsonb, text, text) from public;

-- ---------------------------------------------------------------------------
-- Handler: apply the kind to the target (apply_creature_effect works on any
-- permanent for destroy/exile/bounce/tap/untap).
-- ---------------------------------------------------------------------------
create or replace function public.handle_permanent_effect(
  p_session_id uuid,
  p_stack_item public.game_stack_items
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.apply_creature_effect(
    p_session_id,
    lower(coalesce(p_stack_item.payload ->> 'kind', '')),
    nullif(p_stack_item.payload ->> 'target_card_id', '')::uuid,
    p_stack_item.payload
  );
  return null;
end;
$$;

revoke all on function public.handle_permanent_effect(uuid, public.game_stack_items) from public;

-- ---------------------------------------------------------------------------
-- Allow the new action type on the stack (reproduces the mig 112 allow-list + 1).
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
    'multi_creature_effect', 'permanent_effect'
  ]));

-- ---------------------------------------------------------------------------
-- Register the action type (idempotent).
-- ---------------------------------------------------------------------------
insert into public.stack_action_handlers (action_type, handler_fn, builder_fn, description) values
  ('permanent_effect', 'handle_permanent_effect', 'build_stack_payload_permanent_simple',
   'Apply a removal effect (destroy/exile/bounce/tap/untap) to a target permanent of any type')
on conflict (action_type) do update
  set handler_fn = excluded.handler_fn,
      builder_fn = excluded.builder_fn,
      description = excluded.description;
