-- supabase/functions_src/build_stack_payload_permanent_simple.sql
-- CANONICAL current definition (seeded from 202605010152_assassins_trophy_rider.sql).
-- Edit THIS file, then generate a migration with scripts/new-migration.mjs —
-- never re-extract from past migrations.

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
  -- gain_control: a cast permanent-targeted control change. `to:opponent`
  -- DONATES the target (one you control) to an opponent (Harmless Offering);
  -- otherwise the caster gains control. handle_permanent_effect picks the
  -- acting controller.
  if v_kind not in ('destroy', 'exile', 'bounce', 'tap', 'untap', 'gain_control') then
    raise exception 'Unsupported permanent effect kind: %', v_kind;
  end if;

  v_target_card_id := nullif(p_payload ->> 'target_card_id', '')::uuid;
  if v_target_card_id is null then
    raise exception 'target_card_id is required';
  end if;

  v_target_type := coalesce(p_payload -> 'target_type', '"permanent"'::jsonb);

  if not public.permanent_target_controller_ok(p_session_id, v_target_card_id, p_actor, p_target_controller, v_target_type) then
    raise exception 'Target is not a legal permanent for this spell';
  end if;

  -- NEGATIVE type restriction (mig 220, Cruel Revival "Destroy target NON-Zombie
  -- creature"): reject a target whose type line matches exclude_type_line.
  if nullif(p_payload ->> 'exclude_type_line', '') is not null and exists (
    select 1 from public.game_cards gc
    join public.cards c on c.id = gc.card_id
    where gc.id = v_target_card_id and gc.session_id = p_session_id
      and c.type_line ilike '%' || (p_payload ->> 'exclude_type_line') || '%'
  ) then
    raise exception 'Target may not be a % permanent', p_payload ->> 'exclude_type_line';
  end if;

  return jsonb_build_object(
    'kind', v_kind,
    'target_card_id', v_target_card_id,
    'target_type', v_target_type,
    'target_controller', p_target_controller,
    'timing', p_timing,
    'then', coalesce(p_payload -> 'then', '[]'::jsonb),
    'controller_searches_basic_land', coalesce((p_payload ->> 'controller_searches_basic_land')::boolean, false),
    'exclude_type_line', p_payload ->> 'exclude_type_line',
    -- Donate direction for kind=gain_control (Harmless Offering).
    'to', p_payload ->> 'to',
    -- Cruel Revival's second half: the CASTER picks a matching card from their
    -- graveyard after the removal resolves (handled in handle_permanent_effect).
    'then_return_from_graveyard', p_payload -> 'then_return_from_graveyard'
  );
end;
$$;
