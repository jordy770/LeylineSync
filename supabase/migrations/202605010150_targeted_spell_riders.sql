-- Targeted spell RIDERS + the `nonland_permanent` target type (Anguished Unmaking).
--
-- "Exile target nonland permanent. You lose 3 life." needs two things the engine
-- lacked: a way to target a NONLAND permanent (the matcher only did inclusion), and
-- a way to attach an untargeted self-rider ("…and you lose 3 life") to a targeted
-- removal spell (targeted spells were single-effect).
--
-- Both land on the existing permanent_effect path (mig 113), reproduced here:
--   * card_type_line_matches_target — a `nonland_permanent` (alias `nonland`) token
--     matches any permanent whose type_line is NOT a land.
--   * build_stack_payload_permanent_simple — carries an optional `then` array onto
--     the stack payload.
--   * handle_permanent_effect — after the main removal, applies the `then` riders to
--     the CASTER. Riders are simple untargeted effects: lose_life / gain_life / draw
--     (covers "…and you lose/gain N life / draw a card"). A life rider that drops the
--     caster to 0 is caught by finalize_stack_resolution's existing finish check.
--
-- No new action type / CHECK / registry rows — permanent_effect already exists.
-- (IDE T-SQL false-positives on $$ bodies — ignore.)

-- ---------------------------------------------------------------------------
-- 1. Type matcher + the `nonland_permanent` token (reproduced from mig 113).
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
         -- "nonland permanent": any permanent that is not a land.
         or (lower(t.value) in ('nonland_permanent', 'nonland')
             and coalesce(p_type_line, '') not ilike '%land%')
         or coalesce(p_type_line, '') ilike '%' || lower(t.value) || '%'
    )
  end;
$$;

grant all on function public.card_type_line_matches_target(text, jsonb) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Builder — carry the optional `then` riders onto the stack payload.
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

  v_target_type := coalesce(p_payload -> 'target_type', '"permanent"'::jsonb);

  if not public.permanent_target_controller_ok(p_session_id, v_target_card_id, p_actor, p_target_controller, v_target_type) then
    raise exception 'Target is not a legal permanent for this spell';
  end if;

  return jsonb_build_object(
    'kind', v_kind,
    'target_card_id', v_target_card_id,
    'target_type', v_target_type,
    'target_controller', p_target_controller,
    'timing', p_timing,
    'then', coalesce(p_payload -> 'then', '[]'::jsonb)
  );
end;
$$;

revoke all on function public.build_stack_payload_permanent_simple(uuid, uuid, jsonb, text, text) from public;

-- ---------------------------------------------------------------------------
-- 3. Handler — apply the removal, then the `then` riders to the caster.
-- ---------------------------------------------------------------------------
create or replace function public.handle_permanent_effect(
  p_session_id uuid,
  p_stack_item public.game_stack_items
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_controller uuid := p_stack_item.controller_player_id;
  v_rider jsonb;
  v_rtype text;
  v_ramount integer;
  v_card uuid;
  v_pos integer;
  i integer;
begin
  perform public.apply_creature_effect(
    p_session_id,
    lower(coalesce(p_stack_item.payload ->> 'kind', '')),
    nullif(p_stack_item.payload ->> 'target_card_id', '')::uuid,
    p_stack_item.payload
  );

  -- Riders: simple untargeted effects applied to the CASTER ("...and you lose 3 life").
  for v_rider in
    select value from jsonb_array_elements(coalesce(p_stack_item.payload -> 'then', '[]'::jsonb))
  loop
    v_rtype := lower(coalesce(v_rider ->> 'type', ''));
    v_ramount := coalesce((v_rider ->> 'amount')::integer, 0);

    if v_rtype = 'lose_life' then
      update public.game_session_players
      set life_total = greatest(0, life_total - v_ramount)
      where session_id = p_session_id and player_id = v_controller;

    elsif v_rtype = 'gain_life' then
      update public.game_session_players
      set life_total = life_total + v_ramount
      where session_id = p_session_id and player_id = v_controller;

    elsif v_rtype = 'draw' then
      for i in 1..greatest(0, v_ramount) loop
        select id into v_card
        from public.game_cards
        where session_id = p_session_id and owner_id = v_controller and zone = 'library'
        order by zone_position asc, id asc
        limit 1 for update skip locked;

        exit when v_card is null;

        select coalesce(max(zone_position), -1) + 1 into v_pos
        from public.game_cards
        where session_id = p_session_id and owner_id = v_controller and zone = 'hand';

        update public.game_cards
        set zone = 'hand', zone_position = v_pos, is_tapped = false, damage_marked = 0
        where id = v_card;
      end loop;

    else
      raise exception 'Unsupported rider effect in then: % (allowed: lose_life, gain_life, draw)', v_rtype;
    end if;
  end loop;

  return null;
end;
$$;

revoke all on function public.handle_permanent_effect(uuid, public.game_stack_items) from public;
