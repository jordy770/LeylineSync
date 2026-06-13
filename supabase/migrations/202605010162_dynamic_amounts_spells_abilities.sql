-- Dynamic amounts on the SPELL + ACTIVATED-ABILITY surfaces (roadmap Counters #5b/#8b
-- frontier — extends mig 161 beyond the trigger/source path).
--
-- mig 161 made apply_triggered_ability_effects resolve { counters, of } amounts (the
-- untargeted trigger/source path). This extends the SAME resolver to:
--   * targeted spell effects on creatures (apply_creature_effect) — "deal damage / put
--     counters on target creature equal to <counters>", incl. counters ON THE TARGET;
--   * activated abilities (activate_ability) — resolved at activation time against the
--     source permanent (so "{T}: deal damage equal to ~'s +1/+1 counters" works), the
--     concrete integer then flows through the existing stack builders unchanged.
--
-- resolve_dynamic_amount gains a 5th arg p_target_card_id (default null) + an
-- of:"target" branch (counters on the targeted permanent). The 4-arg mig-161 call in
-- apply_triggered_ability_effects still resolves (5th defaults null). The untargeted
-- program path (cast_spell_effect) already substitutes X and routes untargeted effects
-- through apply_triggered_ability_effects, so it inherits {counters, of:"you"} for free.
--
-- SCOPE notes: a spell's "of":"self" is empty (a spell has no counters) — use "of":
-- "you" / "of":"target". The builders (build_stack_payload_*) are untouched: activated
-- abilities pre-resolve to an integer in activate_ability, so the builder still sees a
-- number. Reproduced from CURRENT (grep-first): resolve_dynamic_amount (161),
-- apply_creature_effect (158), activate_ability (160). (IDE T-SQL false-positives.)

-- ===========================================================================
-- resolve_dynamic_amount — + p_target_card_id and of:"target". Drop the 4-arg (mig
-- 161) first: a 5-arg-with-default coexisting with it makes 4-arg calls ambiguous
-- ("function is not unique"). The mig-161 caller then resolves to the 5-arg via default.
-- ===========================================================================
drop function if exists public.resolve_dynamic_amount(uuid, uuid, uuid, jsonb);

create or replace function public.resolve_dynamic_amount(
  p_session_id uuid,
  p_source_card_id uuid,
  p_controller_id uuid,
  p_amount jsonb,
  p_target_card_id uuid default null
) returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_txt text;
  v_kind text;
  v_of text;
  v_card uuid;
  v_count integer := 0;
begin
  if p_amount is null then
    return 0;
  end if;

  if jsonb_typeof(p_amount) in ('number', 'string') then
    v_txt := p_amount #>> '{}';
    if v_txt = 'X' then
      return 0; -- triggered/source effects have no chosen X
    end if;
    -- NO clamp: a NEGATIVE literal removes counters (mig 155 removal path).
    return coalesce(floor(v_txt::numeric)::integer, 0);
  end if;

  if jsonb_typeof(p_amount) = 'object' then
    v_kind := lower(coalesce(p_amount ->> 'counters', ''));
    v_of := lower(coalesce(p_amount ->> 'of', 'self'));

    if v_of in ('you', 'your', 'controller') then
      select coalesce((counters ->> v_kind)::integer, 0)
      into v_count
      from public.game_session_players
      where session_id = p_session_id and player_id = p_controller_id;

      return greatest(0, coalesce(v_count, 0));
    end if;

    -- self / source / this → the source permanent; target → the targeted permanent.
    if v_of = 'target' then
      v_card := p_target_card_id;
    else
      v_card := p_source_card_id;
    end if;

    if public.is_plus_one_counter(v_kind) then
      select coalesce(plus_one_counters, 0)
      into v_count
      from public.game_cards
      where id = v_card and session_id = p_session_id;
    else
      select coalesce((counters ->> v_kind)::integer, 0)
      into v_count
      from public.game_cards
      where id = v_card and session_id = p_session_id;
    end if;

    return greatest(0, coalesce(v_count, 0));
  end if;

  return 0;
end;
$$;
grant execute on function public.resolve_dynamic_amount(uuid, uuid, uuid, jsonb, uuid) to authenticated;
grant execute on function public.resolve_dynamic_amount(uuid, uuid, uuid, jsonb, uuid) to service_role;

-- ===========================================================================
-- apply_creature_effect (CURRENT = mig 158) — resolve a dynamic amount for targeted
-- spell/ability creature effects: source is unknown here (a spell has no counters), so
-- of:"you" → acting_controller, of:"target" → the target permanent. ONLY the amount
-- read changes; everything else (Doubling Season, recheck) is verbatim from 158.
-- ===========================================================================
create or replace function public.apply_creature_effect(
  p_session_id uuid,
  p_kind text,
  p_target_card_id uuid,
  p_params jsonb default '{}'::jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount integer;
  v_target_owner_id uuid;
  v_next_position integer;
  v_keyword text;
  v_acting_controller uuid;
  v_duration text;
  v_prev_controller uuid;
  v_counter_type text;
  v_all boolean;
begin
  if p_target_card_id is null then
    return;
  end if;

  -- Amount may be a number, "X" (→0), or { counters, of } resolved against game state.
  -- of:"you" → the acting controller; of:"target" → this target permanent.
  v_amount := public.resolve_dynamic_amount(
    p_session_id, null,
    nullif(p_params ->> 'acting_controller', '')::uuid,
    p_params -> 'amount',
    p_target_card_id);

  if p_kind = 'deal_damage' then
    if v_amount > 0 then
      perform public.apply_damage_to_creature(
        p_session_id, p_target_card_id, v_amount, null, false,
        coalesce((p_params ->> 'deathtouch')::boolean, false)
      );
    end if;

  elsif p_kind = 'destroy' then
    perform public.put_in_graveyard(p_session_id, p_target_card_id);

  elsif p_kind = 'exile' then
    select owner_id into v_target_owner_id
    from public.game_cards
    where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield';
    if found then
      select coalesce(max(zone_position), -1) + 1 into v_next_position
      from public.game_cards
      where session_id = p_session_id and owner_id = v_target_owner_id and zone = 'exile';
      update public.game_cards
      set zone = 'exile', zone_position = v_next_position, controller_player_id = owner_id,
          is_tapped = false, damage_marked = 0, dealt_deathtouch_damage = false, plus_one_counters = 0
      where id = p_target_card_id;
    end if;

  elsif p_kind = 'bounce' then
    select owner_id into v_target_owner_id
    from public.game_cards
    where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield';
    if found then
      select coalesce(max(zone_position), -1) + 1 into v_next_position
      from public.game_cards
      where session_id = p_session_id and owner_id = v_target_owner_id and zone = 'hand';
      update public.game_cards
      set zone = 'hand', zone_position = v_next_position, controller_player_id = owner_id,
          is_tapped = false, damage_marked = 0, dealt_deathtouch_damage = false, plus_one_counters = 0
      where id = p_target_card_id;
    end if;

  elsif p_kind in ('tap', 'untap') then
    update public.game_cards
    set is_tapped = (p_kind = 'tap')
    where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield';

  elsif p_kind = 'add_counters' then
    v_counter_type := p_params ->> 'counter_type';
    v_all := coalesce((p_params ->> 'all')::boolean, false);
    if v_amount <> 0 or v_all then
      -- Doubling Season etc: the recipient's controller's replacement multiplies
      -- counters PUT ON it. Removal (negative) / `all` are not doubled.
      if v_amount > 0 then
        v_amount := v_amount * public.counter_factor(
          p_session_id,
          (select controller_player_id from public.game_cards
           where id = p_target_card_id and session_id = p_session_id));
      end if;
      if public.is_plus_one_counter(v_counter_type) then
        update public.game_cards
        set plus_one_counters = case when v_all then 0 else greatest(0, plus_one_counters + v_amount) end
        where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield';
      else
        update public.game_cards
        set counters = case when v_all then counters - lower(v_counter_type)
                            else public.adjust_counter_bag(counters, lower(v_counter_type), v_amount) end
        where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield';
      end if;
      -- Any counter change can annihilate (+1/+1 vs −1/−1) or drop toughness to lethal.
      perform public.recheck_counter_state(p_session_id);
    end if;

  elsif p_kind = 'pump' then
    if exists (select 1 from public.game_cards where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield') then
      perform public.create_pt_pump(
        p_session_id, p_target_card_id,
        coalesce((p_params ->> 'power')::integer, 0),
        coalesce((p_params ->> 'toughness')::integer, 0)
      );
    end if;

  elsif p_kind = 'set_pt' then
    if exists (select 1 from public.game_cards where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield') then
      insert into public.game_continuous_effects (
        session_id, source_card_id, affected_card_id, effect_type, payload,
        source_zone_required, expires_at_phase, expires_at_step
      )
      values (
        p_session_id, p_target_card_id, p_target_card_id, 'set_pt',
        jsonb_build_object(
          'power', coalesce((p_params ->> 'power')::integer, 0),
          'toughness', coalesce((p_params ->> 'toughness')::integer, 0),
          'until_end_of_turn', true
        ),
        'battlefield', 'ending', 'cleanup'
      );
    end if;

  elsif p_kind = 'grant_keyword' then
    v_keyword := lower(coalesce(p_params ->> 'keyword', ''));
    if v_keyword not in (
      'flying', 'reach', 'trample', 'vigilance', 'haste',
      'first_strike', 'double_strike', 'deathtouch', 'indestructible'
    ) then
      raise exception 'Unsupported keyword grant: %', v_keyword;
    end if;
    if exists (select 1 from public.game_cards where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield') then
      insert into public.game_continuous_effects (
        session_id, source_card_id, affected_card_id, effect_type, payload,
        source_zone_required, expires_at_phase, expires_at_step
      )
      values (
        p_session_id, p_target_card_id, p_target_card_id, v_keyword,
        jsonb_build_object('until_end_of_turn', true),
        'battlefield', 'ending', 'cleanup'
      );
    end if;

  elsif p_kind = 'gain_control' then
    v_acting_controller := nullif(p_params ->> 'acting_controller', '')::uuid;
    if v_acting_controller is null then
      raise exception 'gain_control requires an acting controller';
    end if;
    v_duration := lower(coalesce(p_params ->> 'duration', 'permanent'));
    if v_duration not in ('permanent', 'end_of_turn') then
      raise exception 'Unsupported gain_control duration: %', v_duration;
    end if;
    select controller_player_id into v_prev_controller
    from public.game_cards
    where id = p_target_card_id and session_id = p_session_id and zone = 'battlefield';
    if found then
      update public.game_cards
      set controller_player_id = v_acting_controller,
          is_tapped = case when coalesce((p_params ->> 'untap')::boolean, false) then false else is_tapped end
      where id = p_target_card_id;
      if coalesce((p_params ->> 'haste')::boolean, false) then
        insert into public.game_continuous_effects (
          session_id, source_card_id, affected_card_id, effect_type, payload,
          source_zone_required, expires_at_phase, expires_at_step
        )
        values (
          p_session_id, p_target_card_id, p_target_card_id, 'haste',
          jsonb_build_object('until_end_of_turn', true),
          'battlefield', 'ending', 'cleanup'
        );
      end if;
      if v_duration = 'end_of_turn' then
        insert into public.game_continuous_effects (
          session_id, source_card_id, affected_card_id, effect_type, payload,
          source_zone_required, expires_at_phase, expires_at_step
        )
        values (
          p_session_id, p_target_card_id, p_target_card_id, 'control',
          jsonb_build_object('original_controller', v_prev_controller),
          'battlefield', 'ending', 'cleanup'
        );
      end if;
    end if;

  else
    raise exception 'Unsupported creature effect kind: %', p_kind;
  end if;
end;
$$;
grant execute on function public.apply_creature_effect(uuid, text, uuid, jsonb) to authenticated;

-- ===========================================================================
-- activate_ability (CURRENT = mig 160) — resolve a dynamic amount AT ACTIVATION
-- against the source permanent (of:"self") / controller (of:"you") / target
-- (of:"target"); the concrete integer flows through the stack builders unchanged.
-- ONLY the amount read changes; everything else verbatim from 160.
-- ===========================================================================
create or replace function public.activate_ability(
  p_session_id uuid,
  p_source_card_id uuid,
  p_ability_index integer default 0,
  p_target_player_id uuid default null,
  p_target_card_id uuid default null,
  p_generic_payment jsonb default null
) returns public.game_stack_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_turn public.game_turn_state;
  v_zone text;
  v_script jsonb;
  v_ability jsonb;
  v_cost jsonb;
  v_effect jsonb;
  v_eff_type text;
  v_target_controller text;
  v_has_tap boolean := false;
  v_mana_cost text := null;
  v_energy_cost integer := 0;
  v_player_energy integer;
  v_amount integer;
  v_stack public.game_stack_items;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select *
  into v_turn
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if coalesce(v_turn.priority_player_id, v_turn.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can activate abilities';
  end if;

  select game_cards.zone
  into v_zone
  from public.game_cards
  where game_cards.id = p_source_card_id
    and game_cards.session_id = p_session_id
    and game_cards.owner_id = auth.uid();

  if not found then
    raise exception 'Source card not found or not owned by current user';
  end if;

  if v_zone <> 'battlefield' then
    raise exception 'Ability source must be on the battlefield';
  end if;

  v_script := public.effective_script(p_session_id, p_source_card_id);
  v_ability := v_script -> 'activated_abilities' -> p_ability_index;

  if v_ability is null then
    raise exception 'Activated ability not found at index %', p_ability_index;
  end if;

  if coalesce((v_ability ->> 'is_mana_ability')::boolean, false) then
    raise exception 'Use the mana ability flow for mana abilities';
  end if;

  -- Parse costs
  for v_cost in select * from jsonb_array_elements(coalesce(v_ability -> 'costs', '[]'::jsonb))
  loop
    case v_cost ->> 'type'
      when 'tap_self' then v_has_tap := true;
      when 'mana' then v_mana_cost := v_cost ->> 'amount';
      when 'energy' then v_energy_cost := greatest(0, coalesce((v_cost ->> 'amount')::integer, 0));
      else raise exception 'Unsupported ability cost: %', v_cost ->> 'type';
    end case;
  end loop;

  if v_has_tap and exists (
    select 1 from public.game_cards where id = p_source_card_id and is_tapped = true
  ) then
    raise exception 'Source is already tapped';
  end if;

  -- Energy: the activating player must have enough in their pool.
  if v_energy_cost > 0 then
    select coalesce((counters ->> 'energy')::integer, 0)
    into v_player_energy
    from public.game_session_players
    where session_id = p_session_id and player_id = auth.uid();

    if coalesce(v_player_energy, 0) < v_energy_cost then
      raise exception 'Not enough energy: need % (have %)', v_energy_cost, coalesce(v_player_energy, 0);
    end if;
  end if;

  if v_mana_cost is not null then
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_mana_cost, p_generic_payment);
  end if;

  if v_energy_cost > 0 then
    update public.game_session_players
    set counters = public.adjust_counter_bag(counters, 'energy', -v_energy_cost)
    where session_id = p_session_id and player_id = auth.uid();
  end if;

  if v_has_tap then
    update public.game_cards
    set is_tapped = true
    where id = p_source_card_id and session_id = p_session_id;
  end if;

  -- Apply the (single) effect by putting the matching stack action on the stack.
  v_effect := v_ability -> 'effects' -> 0;
  if v_effect is null then
    raise exception 'Activated ability has no effect';
  end if;

  v_eff_type := lower(coalesce(v_effect ->> 'type', ''));
  v_target_controller := coalesce(lower(nullif(v_effect ->> 'target_controller', '')), 'any');
  -- Dynamic amount resolved NOW against the source permanent / controller / target.
  v_amount := public.resolve_dynamic_amount(
    p_session_id, p_source_card_id, auth.uid(), v_effect -> 'amount', p_target_card_id);

  if v_eff_type = 'draw' then
    v_stack := public.put_action_on_stack(
      p_session_id, 'draw_cards',
      jsonb_build_object('amount', greatest(1, v_amount), 'timing', 'instant'),
      p_source_card_id
    );

  elsif v_eff_type = 'deal_damage' then
    if v_amount <= 0 then
      raise exception 'Invalid damage amount';
    end if;
    if p_target_card_id is not null then
      v_stack := public.put_action_on_stack(
        p_session_id, 'deal_damage_creature',
        jsonb_build_object('target_card_id', p_target_card_id, 'amount', v_amount, 'target_controller', v_target_controller, 'timing', 'instant'),
        p_source_card_id
      );
    elsif p_target_player_id is not null then
      v_stack := public.put_action_on_stack(
        p_session_id, 'deal_damage_player',
        jsonb_build_object('target_player_id', p_target_player_id, 'amount', v_amount, 'timing', 'instant'),
        p_source_card_id
      );
    else
      raise exception 'A target is required for this ability';
    end if;

  elsif v_eff_type in ('destroy', 'exile', 'bounce', 'tap', 'untap') then
    if p_target_card_id is null then
      raise exception 'A target is required for this ability';
    end if;
    v_stack := public.put_action_on_stack(
      p_session_id, v_eff_type || '_creature',
      jsonb_build_object('target_card_id', p_target_card_id, 'target_controller', v_target_controller, 'timing', 'instant'),
      p_source_card_id
    );

  elsif v_eff_type = 'add_counters' then
    if p_target_card_id is null then
      raise exception 'A target is required for this ability';
    end if;
    if v_amount <= 0 then
      raise exception 'Invalid counter amount';
    end if;
    v_stack := public.put_action_on_stack(
      p_session_id, 'add_counters_creature',
      jsonb_build_object('target_card_id', p_target_card_id, 'amount', v_amount, 'target_controller', v_target_controller, 'timing', 'instant'),
      p_source_card_id
    );

  elsif v_eff_type = 'pump' then
    if p_target_card_id is null then
      raise exception 'A target is required for this ability';
    end if;
    v_stack := public.put_action_on_stack(
      p_session_id, 'pump_creature',
      jsonb_build_object('target_card_id', p_target_card_id,
        'power', coalesce((v_effect ->> 'power')::integer, 0),
        'toughness', coalesce((v_effect ->> 'toughness')::integer, 0),
        'target_controller', v_target_controller, 'timing', 'instant'),
      p_source_card_id
    );

  elsif v_eff_type = 'grant_keyword' then
    if p_target_card_id is null then
      raise exception 'A target is required for this ability';
    end if;
    v_stack := public.put_action_on_stack(
      p_session_id, 'grant_keyword_creature',
      jsonb_build_object('target_card_id', p_target_card_id, 'keyword', lower(coalesce(v_effect ->> 'keyword', '')),
        'target_controller', v_target_controller, 'timing', 'instant'),
      p_source_card_id
    );

  elsif v_eff_type = 'gain_control' then
    if p_target_card_id is null then
      raise exception 'A target is required for this ability';
    end if;
    v_stack := public.put_action_on_stack(
      p_session_id, 'gain_control_creature',
      jsonb_build_object('target_card_id', p_target_card_id,
        'duration', coalesce(v_effect ->> 'duration', 'permanent'),
        'untap', coalesce((v_effect ->> 'untap')::boolean, false),
        'haste', coalesce((v_effect ->> 'haste')::boolean, false),
        'target_controller', v_target_controller, 'timing', 'instant'),
      p_source_card_id
    );

  else
    raise exception 'Unsupported ability effect: %', v_eff_type;
  end if;

  return v_stack;
end;
$$;

grant execute on function public.activate_ability(uuid, uuid, integer, uuid, uuid, jsonb) to authenticated;

-- ===========================================================================
-- Targeted-spell builders — resolve a { counters, of } amount at put-on-stack time
-- (the builder runs BEFORE the int is frozen into the payload). of:"self" is null here
-- (a spell has no counters); of:"you" → the caster (p_actor); of:"target" → the spell's
-- target. A literal number / "X" keeps the existing resolve_effect_amount path (so
-- {X} targeted spells still work). build_stack_payload_deal_damage_creature (CURRENT =
-- mig 109), build_stack_payload_add_counters_creature (CURRENT = mig 155).
-- ===========================================================================
create or replace function public.build_stack_payload_deal_damage_creature(
  p_session_id uuid, p_actor uuid, p_payload jsonb, p_timing text, p_target_controller text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_target_card_id uuid;
  v_amount integer;
begin
  v_target_card_id := nullif(p_payload ->> 'target_card_id', '')::uuid;
  if jsonb_typeof(p_payload -> 'amount') = 'object' then
    v_amount := public.resolve_dynamic_amount(p_session_id, null, p_actor, p_payload -> 'amount', v_target_card_id);
  else
    v_amount := public.resolve_effect_amount(p_payload ->> 'amount', (p_payload ->> 'x_value')::integer);
  end if;

  if v_target_card_id is null then
    raise exception 'target_card_id is required';
  end if;
  if v_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  if not public.creature_target_controller_ok(p_session_id, v_target_card_id, p_actor, p_target_controller) then
    raise exception 'Target is not a legal creature for this spell';
  end if;

  return jsonb_build_object(
    'target_card_id', v_target_card_id,
    'amount', v_amount,
    'target_controller', p_target_controller,
    'timing', p_timing
  );
end;
$$;

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
  );
end;
$$;

revoke all on function public.build_stack_payload_deal_damage_creature(uuid, uuid, jsonb, text, text) from public;
revoke all on function public.build_stack_payload_add_counters_creature(uuid, uuid, jsonb, text, text) from public;
