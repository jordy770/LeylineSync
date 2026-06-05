-- Phase 1, slice 12 — X spells (variable amounts paid as {X} generic mana).
--
-- A card script may now write an effect amount of the literal string "X" (e.g.
-- Fireball: deal_damage amount "X"; Mind Spring: draw amount "X"). The caster
-- chooses a number at cast time and pays it as {X} generic mana; the SERVER then
-- substitutes that chosen value into the effect amount. Resolving X server-side
-- (not trusting a client-sent amount) ties the effect size to the mana actually
-- paid — a client cannot pay 1 and deal 999.
--
-- THREE SEAMS:
--  1. pay_mana_cost gains p_x_value (default 0) and learns to parse {X}, which
--     the old regex silently dropped. Each X symbol adds p_x_value generic mana.
--     Dropped + recreated (not a new overload) so every existing 4-arg caller
--     resolves to the one function via the default.
--  2. Targeted path (put_action_on_stack, mig 105): reads x_value from the jsonb
--     payload and forwards it to pay_mana_cost; the amount-bearing builders
--     resolve amount "X" -> x_value via resolve_effect_amount. Signature
--     unchanged (X rides in the payload).
--  3. Untargeted program path (cast_spell_effect, mig 094): gains p_x_value,
--     substitutes "X" -> x_value in the effects list, and — BEHAVIOR CHANGE —
--     now pays the source card's mana cost (it previously paid nothing). Guarded
--     by source-from-hand + non-empty mana_cost, so the free-cast test fixtures
--     (no mana_cost) are unaffected.
--
-- "X" is resolved only at the top level of the effects list and for the amount-
-- bearing builders; nested effects (inside may/choose_player) and other keys are
-- left as-is. (IDE T-SQL false-positives on $$ bodies — ignore.)

-- ---------------------------------------------------------------------------
-- Shared resolver: a fixed number passes through; the literal "X" becomes the
-- caster-chosen value (clamped to >= 0).
-- ---------------------------------------------------------------------------
create or replace function public.resolve_effect_amount(p_raw text, p_x integer)
returns integer
language sql
immutable
set search_path = public
as $$
  select case
    when p_raw = 'X' then greatest(coalesce(p_x, 0), 0)
    else coalesce(p_raw::integer, 0)
  end;
$$;

-- ---------------------------------------------------------------------------
-- 1. pay_mana_cost — add p_x_value and parse {X}. Verbatim from baseline except
-- the new param, the v_x_count declaration, and the {X} block. Drop first so a
-- single 5-arg function (5th defaulted) replaces the 4-arg one.
-- ---------------------------------------------------------------------------
drop function if exists public.pay_mana_cost(uuid, uuid, text, jsonb);

create or replace function public.pay_mana_cost(
  p_session_id uuid,
  p_player_id uuid,
  p_mana_cost text,
  p_generic_payment jsonb default null,
  p_x_value integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $_$
declare
  v_empty_pool jsonb := jsonb_build_object('W', 0, 'U', 0, 'B', 0, 'R', 0, 'G', 0, 'C', 0);
  v_current_pool jsonb;
  v_new_pool jsonb;
  v_clean_cost text;
  v_symbol text;
  v_generic_cost integer := 0;
  v_x_count integer := 0;
  v_available_generic integer := 0;
  v_declared_generic_payment integer := 0;
  v_pay_amount integer;
  v_color text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_player_id <> auth.uid() then
    raise exception 'Cannot pay mana for another player';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if p_mana_cost is null or btrim(p_mana_cost) = '' then
    return v_empty_pool;
  end if;

  insert into public.game_players (session_id, player_id, mana_pool)
  values (p_session_id, p_player_id, v_empty_pool)
  on conflict (session_id, player_id) do nothing;

  select coalesce(mana_pool, v_empty_pool)
  into v_current_pool
  from public.game_players
  where session_id = p_session_id
    and player_id = p_player_id
  for update;

  v_new_pool := v_current_pool;
  v_clean_cost := upper(regexp_replace(p_mana_cost, '[{}\s]', '', 'g'));

  for v_symbol in
    select token[1]
    from regexp_matches(v_clean_cost, '([0-9]+|[WUBRGC])', 'g') as token
  loop
    if v_symbol ~ '^[0-9]+$' then
      v_generic_cost := v_generic_cost + v_symbol::integer;
    else
      v_pay_amount := coalesce((v_new_pool ->> v_symbol)::integer, 0);

      if v_pay_amount <= 0 then
        raise exception 'Not enough % mana to pay %', v_symbol, p_mana_cost;
      end if;

      v_new_pool := v_new_pool || jsonb_build_object(v_symbol, v_pay_amount - 1);
    end if;
  end loop;

  -- {X}: each X symbol costs the caster-chosen value in generic mana. The regex
  -- above never matches X, so it contributed nothing until now.
  v_x_count := length(v_clean_cost) - length(replace(v_clean_cost, 'X', ''));
  if v_x_count > 0 then
    v_generic_cost := v_generic_cost + v_x_count * greatest(coalesce(p_x_value, 0), 0);
  end if;

  if v_generic_cost > 0 then
    select sum(coalesce((v_new_pool ->> color_symbol)::integer, 0))
    into v_available_generic
    from unnest(array['C', 'W', 'U', 'B', 'R', 'G']) as color_symbol;

    if coalesce(v_available_generic, 0) < v_generic_cost then
      raise exception 'Not enough mana to pay generic cost % for %', v_generic_cost, p_mana_cost;
    end if;

    if p_generic_payment is not null and p_generic_payment <> 'null'::jsonb then
      foreach v_color in array array['C', 'W', 'U', 'B', 'R', 'G']
      loop
        v_pay_amount := coalesce((p_generic_payment ->> v_color)::integer, 0);

        if v_pay_amount < 0 then
          raise exception 'Generic mana payment cannot be negative';
        end if;

        v_declared_generic_payment := v_declared_generic_payment + v_pay_amount;
      end loop;

      if v_declared_generic_payment <> v_generic_cost then
        raise exception 'Generic mana payment must total %, got %', v_generic_cost, v_declared_generic_payment;
      end if;

      foreach v_color in array array['C', 'W', 'U', 'B', 'R', 'G']
      loop
        v_pay_amount := coalesce((p_generic_payment ->> v_color)::integer, 0);

        if v_pay_amount > coalesce((v_new_pool ->> v_color)::integer, 0) then
          raise exception 'Not enough % mana to pay chosen generic cost', v_color;
        end if;

        if v_pay_amount > 0 then
          v_new_pool := v_new_pool || jsonb_build_object(
            v_color,
            coalesce((v_new_pool ->> v_color)::integer, 0) - v_pay_amount
          );
        end if;
      end loop;
    else
      foreach v_color in array array['C', 'W', 'U', 'B', 'R', 'G']
      loop
        exit when v_generic_cost <= 0;

        v_pay_amount := least(coalesce((v_new_pool ->> v_color)::integer, 0), v_generic_cost);

        if v_pay_amount > 0 then
          v_new_pool := v_new_pool || jsonb_build_object(
            v_color,
            coalesce((v_new_pool ->> v_color)::integer, 0) - v_pay_amount
          );
          v_generic_cost := v_generic_cost - v_pay_amount;
        end if;
      end loop;
    end if;
  end if;

  update public.game_players
  set mana_pool = v_new_pool
  where session_id = p_session_id
    and player_id = p_player_id;

  return v_new_pool;
end;
$_$;

grant execute on function public.pay_mana_cost(uuid, uuid, text, jsonb, integer) to anon;
grant execute on function public.pay_mana_cost(uuid, uuid, text, jsonb, integer) to authenticated;
grant execute on function public.pay_mana_cost(uuid, uuid, text, jsonb, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 2a. Amount-bearing builders (mig 105) now resolve amount "X" -> x_value. Only
-- the amount line changes; the rest is a verbatim lift.
-- ---------------------------------------------------------------------------
create or replace function public.build_stack_payload_deal_damage_player(
  p_session_id uuid, p_actor uuid, p_payload jsonb, p_timing text, p_target_controller text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_target_player_id uuid;
  v_amount integer;
begin
  v_target_player_id := nullif(p_payload ->> 'target_player_id', '')::uuid;
  v_amount := public.resolve_effect_amount(p_payload ->> 'amount', (p_payload ->> 'x_value')::integer);

  if v_target_player_id is null then
    raise exception 'target_player_id is required';
  end if;
  if v_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  if not public.is_session_player(p_session_id, v_target_player_id) then
    raise exception 'Target player is not a player in this session';
  end if;

  return jsonb_build_object(
    'target_player_id', v_target_player_id,
    'amount', v_amount,
    'timing', p_timing
  );
end;
$$;

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
  v_amount := public.resolve_effect_amount(p_payload ->> 'amount', (p_payload ->> 'x_value')::integer);

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
begin
  v_target_card_id := nullif(p_payload ->> 'target_card_id', '')::uuid;
  v_amount := public.resolve_effect_amount(p_payload ->> 'amount', (p_payload ->> 'x_value')::integer);

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

create or replace function public.build_stack_payload_draw_cards(
  p_session_id uuid, p_actor uuid, p_payload jsonb, p_timing text, p_target_controller text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_amount integer;
begin
  v_amount := public.resolve_effect_amount(p_payload ->> 'amount', (p_payload ->> 'x_value')::integer);
  if v_amount <= 0 then
    raise exception 'amount must be positive';
  end if;

  return jsonb_build_object(
    'amount', v_amount,
    'timing', p_timing
  );
end;
$$;

revoke all on function public.build_stack_payload_deal_damage_player(uuid, uuid, jsonb, text, text) from public;
revoke all on function public.build_stack_payload_deal_damage_creature(uuid, uuid, jsonb, text, text) from public;
revoke all on function public.build_stack_payload_add_counters_creature(uuid, uuid, jsonb, text, text) from public;
revoke all on function public.build_stack_payload_draw_cards(uuid, uuid, jsonb, text, text) from public;

-- ---------------------------------------------------------------------------
-- 2b. put_action_on_stack skeleton (mig 105) — read x_value from the payload and
-- forward it to pay_mana_cost so {X} targeted spells are charged. Signature and
-- everything else are verbatim from mig 105.
-- ---------------------------------------------------------------------------
create or replace function public.put_action_on_stack(
  p_session_id uuid,
  p_action_type text,
  p_payload jsonb,
  p_source_card_id uuid default null
)
returns public.game_stack_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_status text;
  v_turn_state public.game_turn_state;
  v_action_timing text;
  v_target_controller text;
  v_source_type_line text;
  v_source_zone text;
  v_source_mana_cost text;
  v_generic_payment jsonb;
  v_x_value integer;
  v_pending_stack_count integer;
  v_next_graveyard_position integer;
  v_next_position integer;
  v_builder_fn text;
  v_built_payload jsonb;
  v_stack_item public.game_stack_items;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  select status
  into v_session_status
  from public.game_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'Game session not found';
  end if;

  if v_session_status = 'finished' then
    raise exception 'Cannot put actions on the stack in a finished game session';
  end if;

  select *
  into v_turn_state
  from public.game_turn_state
  where session_id = p_session_id
  for update;

  if not found then
    raise exception 'Turn state not found';
  end if;

  if coalesce(v_turn_state.priority_player_id, v_turn_state.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can put actions on the stack';
  end if;

  select builder_fn
  into v_builder_fn
  from public.stack_action_handlers
  where action_type = p_action_type;

  if v_builder_fn is null then
    raise exception 'Unsupported stack action type: %', p_action_type;
  end if;

  if p_source_card_id is not null then
    select cards.type_line, cards.mana_cost, game_cards.zone
    into v_source_type_line, v_source_mana_cost, v_source_zone
    from public.game_cards
    join public.cards
      on cards.id = game_cards.card_id
    where game_cards.id = p_source_card_id
      and game_cards.session_id = p_session_id
      and game_cards.owner_id = auth.uid();

    if not found then
      raise exception 'Source card not found or not owned by current user';
    end if;
  end if;

  v_action_timing := lower(nullif(p_payload ->> 'timing', ''));

  if v_action_timing is null then
    if v_source_type_line ilike '%instant%' then
      v_action_timing := 'instant';
    elsif v_source_type_line ilike '%sorcery%' then
      v_action_timing := 'sorcery';
    else
      raise exception 'Action timing is required for non-Instant and non-Sorcery sources';
    end if;
  end if;

  if v_action_timing not in ('instant', 'sorcery') then
    raise exception 'Unsupported action timing: %', v_action_timing;
  end if;

  if p_action_type = 'counter_spell' and v_action_timing <> 'instant' then
    raise exception 'Counterspell actions must use instant timing';
  end if;

  if v_action_timing = 'sorcery' then
    if v_turn_state.active_player_id <> auth.uid() then
      raise exception 'Sorcery actions can only be used by the active player';
    end if;

    if v_turn_state.step not in ('precombat_main', 'postcombat_main') then
      raise exception 'Sorcery actions can only be used during a main phase';
    end if;

    select count(*)
    into v_pending_stack_count
    from public.game_stack_items
    where session_id = p_session_id
      and status = 'pending';

    if v_pending_stack_count > 0 then
      raise exception 'Sorcery actions can only be used while the stack is empty';
    end if;
  end if;

  v_generic_payment := p_payload -> 'generic_payment';
  v_x_value := coalesce((p_payload ->> 'x_value')::integer, 0);
  v_target_controller := coalesce(lower(nullif(p_payload ->> 'target_controller', '')), 'any');

  execute format('select public.%I($1, $2, $3, $4, $5)', v_builder_fn)
    into v_built_payload
    using p_session_id, auth.uid(), p_payload, v_action_timing, v_target_controller;

  if p_source_card_id is not null and v_source_zone = 'hand' then
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_source_mana_cost, v_generic_payment, v_x_value);
  end if;

  select coalesce(max(position), -1) + 1
  into v_next_position
  from public.game_stack_items
  where session_id = p_session_id;

  insert into public.game_stack_items (
    session_id,
    controller_player_id,
    source_card_id,
    action_type,
    payload,
    position
  )
  values (
    p_session_id,
    auth.uid(),
    p_source_card_id,
    p_action_type,
    v_built_payload,
    v_next_position
  )
  returning * into v_stack_item;

  if p_source_card_id is not null
    and v_source_zone = 'hand'
    and (
      v_source_type_line ilike '%instant%'
      or v_source_type_line ilike '%sorcery%'
    )
  then
    select coalesce(max(zone_position), -1) + 1
    into v_next_graveyard_position
    from public.game_cards
    where session_id = p_session_id
      and owner_id = auth.uid()
      and zone = 'graveyard';

    update public.game_cards
    set
      zone = 'graveyard',
      zone_position = v_next_graveyard_position,
      is_tapped = false,
      damage_marked = 0
    where id = p_source_card_id;
  end if;

  return v_stack_item;
end;
$$;

grant execute on function public.put_action_on_stack(uuid, text, jsonb, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. cast_spell_effect (mig 094) — gains p_x_value, substitutes "X" amounts/
-- counts, and now pays the source card's mana cost (with {X}). Drop first so a
-- single 4-arg function (4th defaulted) replaces the 3-arg one; existing 3-arg
-- callers resolve via the default.
-- ---------------------------------------------------------------------------
drop function if exists public.cast_spell_effect(uuid, jsonb, uuid);

create or replace function public.cast_spell_effect(
  p_session_id uuid,
  p_actions jsonb,
  p_source_card_id uuid default null,
  p_x_value integer default null
)
returns public.game_stack_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_turn public.game_turn_state;
  v_session_status text;
  v_source_type_line text;
  v_source_zone text;
  v_source_mana_cost text;
  v_timing text;
  v_pending integer;
  v_next_position integer;
  v_next_graveyard integer;
  v_resolved_actions jsonb;
  v_stack public.game_stack_items;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_session_player(p_session_id, auth.uid()) then
    raise exception 'Current user is not a player in this session';
  end if;

  if jsonb_typeof(p_actions) <> 'array' or jsonb_array_length(p_actions) < 1 then
    raise exception 'Spell effect needs at least one action';
  end if;

  select status into v_session_status
  from public.game_sessions where id = p_session_id for update;
  if not found then
    raise exception 'Game session not found';
  end if;
  if v_session_status = 'finished' then
    raise exception 'Cannot cast in a finished game session';
  end if;

  select * into v_turn
  from public.game_turn_state where session_id = p_session_id for update;
  if not found then
    raise exception 'Turn state not found';
  end if;
  if coalesce(v_turn.priority_player_id, v_turn.active_player_id) <> auth.uid() then
    raise exception 'Only the priority player can cast';
  end if;

  if p_source_card_id is not null then
    select cards.type_line, cards.mana_cost, game_cards.zone
      into v_source_type_line, v_source_mana_cost, v_source_zone
    from public.game_cards
    join public.cards on cards.id = game_cards.card_id
    where game_cards.id = p_source_card_id
      and game_cards.session_id = p_session_id
      and game_cards.owner_id = auth.uid();
    if not found then
      raise exception 'Source card not found or not owned by current user';
    end if;
  end if;

  -- Timing: instants any time the caster has priority; sorceries main-phase only,
  -- empty stack, active player. A sourceless cast (tests) defaults to instant.
  if v_source_type_line ilike '%sorcery%' then
    v_timing := 'sorcery';
  else
    v_timing := 'instant';
  end if;

  if v_timing = 'sorcery' then
    if v_turn.active_player_id <> auth.uid() then
      raise exception 'Sorcery actions can only be used by the active player';
    end if;
    if v_turn.step not in ('precombat_main', 'postcombat_main') then
      raise exception 'Sorcery actions can only be used during a main phase';
    end if;
    select count(*) into v_pending
    from public.game_stack_items
    where session_id = p_session_id and status = 'pending';
    if v_pending > 0 then
      raise exception 'Sorcery actions can only be used while the stack is empty';
    end if;
  end if;

  -- Resolve any top-level "X" amount/count to the caster-chosen x_value before it
  -- is stored on the stack item (resolution code never sees the "X" token).
  select coalesce(jsonb_agg(
    case
      when (elem ->> 'amount') = 'X' or (elem ->> 'count') = 'X' then
        elem
          || (case when (elem ->> 'amount') = 'X'
                then jsonb_build_object('amount', greatest(coalesce(p_x_value, 0), 0)) else '{}'::jsonb end)
          || (case when (elem ->> 'count') = 'X'
                then jsonb_build_object('count', greatest(coalesce(p_x_value, 0), 0)) else '{}'::jsonb end)
      else elem
    end
    order by ord
  ), '[]'::jsonb)
  into v_resolved_actions
  from jsonb_array_elements(p_actions) with ordinality as t(elem, ord);

  -- Non-permanent spell cast from hand: pay its mana cost (including {X}). This is
  -- new — the untargeted program path previously paid nothing. No-op when the
  -- source is sourceless or has no mana_cost (the free-cast test fixtures).
  if p_source_card_id is not null and v_source_zone = 'hand'
    and v_source_mana_cost is not null and btrim(v_source_mana_cost) <> ''
  then
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_source_mana_cost, null, coalesce(p_x_value, 0));
  end if;

  select coalesce(max(position), 0) + 1 into v_next_position
  from public.game_stack_items where session_id = p_session_id;

  insert into public.game_stack_items (
    session_id, controller_player_id, source_card_id, action_type, payload, position, status
  )
  values (
    p_session_id,
    auth.uid(),
    p_source_card_id,
    'spell_effect',
    jsonb_build_object('effects', v_resolved_actions, 'controller_player_id', auth.uid(), 'timing', v_timing),
    v_next_position,
    'pending'
  )
  returning * into v_stack;

  -- Non-permanent spell: move the card from hand to the graveyard on cast.
  if p_source_card_id is not null
    and v_source_zone = 'hand'
    and (v_source_type_line ilike '%instant%' or v_source_type_line ilike '%sorcery%')
  then
    select coalesce(max(zone_position), -1) + 1 into v_next_graveyard
    from public.game_cards
    where session_id = p_session_id and owner_id = auth.uid() and zone = 'graveyard';

    update public.game_cards
    set zone = 'graveyard', zone_position = v_next_graveyard, is_tapped = false, damage_marked = 0
    where id = p_source_card_id;
  end if;

  return v_stack;
end;
$$;

grant execute on function public.cast_spell_effect(uuid, jsonb, uuid, integer) to authenticated;
