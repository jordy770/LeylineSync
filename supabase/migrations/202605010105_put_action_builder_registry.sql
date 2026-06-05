-- Refactor part 2: data-driven cast-side dispatch for put_action_on_stack
-- (behavior-preserving). Companion to migration 104 (resolve_top_of_stack).
--
-- WHY: put_action_on_stack is the OTHER monster re-pasted per creature-targeting
-- SPELL effect (071/079/083/100 each reproduced its ~340 lines to add ONE action
-- type to three spots: the whitelist `in(...)`, the per-action validation chain,
-- and the payload-building `case`). This migration removes that tax the same way
-- 104 did for resolution: each action's validate-and-build-payload logic moves
-- into a builder function of a UNIFORM signature, the whitelist becomes "the
-- registry has a builder_fn for this action_type," and the skeleton (auth, turn,
-- priority, timing, mana, insert, graveyard-move) stops changing.
--
-- BUILDER CONTRACT  build_stack_payload_*(
--     p_session_id uuid, p_actor uuid, p_payload jsonb,
--     p_timing text, p_target_controller text) -> jsonb
--   Validates p_payload (RAISES on invalid input, exactly as the old inline
--   branch did) and RETURNS the jsonb to store as the stack item's payload.
--   Each body below is a VERBATIM lift of its old validation branch + the
--   matching `case` arm — no logic change.
--
-- The five "simple" creature actions (destroy/bounce/tap/untap/exile) share one
-- builder (identical validation + identical {target_card_id,target_controller,
-- timing} payload). The counterspell-timing guard and the sorcery guards stay in
-- the skeleton at their exact positions so error precedence is unchanged.
--
-- Builders are SECURITY DEFINER/search_path=public and reached only via the
-- skeleton's EXECUTE (runs as owner) — no authenticated grant, and PUBLIC execute
-- revoked so they are not exposed as raw PostgREST RPCs. (IDE T-SQL false-
-- positives on $$ bodies — ignore.)

-- ---------------------------------------------------------------------------
-- Registry: add the cast-side builder column. Null builder_fn = not castable via
-- put_action_on_stack (cast_permanent/modal_spell/scry/surveil/spell_effect/
-- fight_creatures/triggered_ability use dedicated cast_* RPCs or are enqueued).
-- ---------------------------------------------------------------------------
alter table public.stack_action_handlers add column if not exists builder_fn text;

-- ---------------------------------------------------------------------------
-- Builders (one verbatim lift per old validation branch + its payload arm).
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
  v_amount := coalesce((p_payload ->> 'amount')::integer, 0);

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
  v_amount := coalesce((p_payload ->> 'amount')::integer, 0);

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

create or replace function public.build_stack_payload_pump_creature(
  p_session_id uuid, p_actor uuid, p_payload jsonb, p_timing text, p_target_controller text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_target_card_id uuid;
  v_pump_power integer;
  v_pump_toughness integer;
begin
  v_target_card_id := nullif(p_payload ->> 'target_card_id', '')::uuid;
  v_pump_power := coalesce((p_payload ->> 'power')::integer, 0);
  v_pump_toughness := coalesce((p_payload ->> 'toughness')::integer, 0);

  if v_target_card_id is null then
    raise exception 'target_card_id is required';
  end if;
  if not public.creature_target_controller_ok(p_session_id, v_target_card_id, p_actor, p_target_controller) then
    raise exception 'Target is not a legal creature for this spell';
  end if;

  return jsonb_build_object(
    'target_card_id', v_target_card_id,
    'power', v_pump_power,
    'toughness', v_pump_toughness,
    'target_controller', p_target_controller,
    'timing', p_timing
  );
end;
$$;

-- destroy / bounce / tap / untap / exile — identical validation + payload.
create or replace function public.build_stack_payload_creature_simple(
  p_session_id uuid, p_actor uuid, p_payload jsonb, p_timing text, p_target_controller text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_target_card_id uuid;
begin
  v_target_card_id := nullif(p_payload ->> 'target_card_id', '')::uuid;

  if v_target_card_id is null then
    raise exception 'target_card_id is required';
  end if;
  if not public.creature_target_controller_ok(p_session_id, v_target_card_id, p_actor, p_target_controller) then
    raise exception 'Target is not a legal creature for this spell';
  end if;

  return jsonb_build_object(
    'target_card_id', v_target_card_id,
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
  v_amount := coalesce((p_payload ->> 'amount')::integer, 0);

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

create or replace function public.build_stack_payload_grant_keyword_creature(
  p_session_id uuid, p_actor uuid, p_payload jsonb, p_timing text, p_target_controller text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_target_card_id uuid;
  v_keyword text;
begin
  v_target_card_id := nullif(p_payload ->> 'target_card_id', '')::uuid;

  if v_target_card_id is null then
    raise exception 'target_card_id is required';
  end if;

  v_keyword := lower(coalesce(p_payload ->> 'keyword', ''));
  if v_keyword not in ('flying','reach','trample','vigilance','haste','first_strike','double_strike','deathtouch','indestructible') then
    raise exception 'Unsupported keyword grant: %', v_keyword;
  end if;

  if not public.creature_target_controller_ok(p_session_id, v_target_card_id, p_actor, p_target_controller) then
    raise exception 'Target is not a legal creature for this spell';
  end if;

  return jsonb_build_object(
    'target_card_id', v_target_card_id,
    'keyword', v_keyword,
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
  v_amount := coalesce((p_payload ->> 'amount')::integer, 0);
  if v_amount <= 0 then
    raise exception 'amount must be positive';
  end if;

  return jsonb_build_object(
    'amount', v_amount,
    'timing', p_timing
  );
end;
$$;

-- counter_spell: lock the targeted pending item and resolve its display label.
-- (The instant-only timing guard stays in the skeleton, at its original spot.)
create or replace function public.build_stack_payload_counter_spell(
  p_session_id uuid, p_actor uuid, p_payload jsonb, p_timing text, p_target_controller text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_target_stack_item public.game_stack_items;
  v_target_stack_label text;
begin
  select *
  into v_target_stack_item
  from public.game_stack_items
  where id = nullif(p_payload ->> 'target_stack_item_id', '')::uuid
    and session_id = p_session_id
    and status = 'pending'
  for update;

  if not found then
    raise exception 'Target stack item not found or no longer pending';
  end if;

  select coalesce(source_card.name, v_target_stack_item.action_type)
  into v_target_stack_label
  from public.game_stack_items target_stack
  left join public.game_cards source_instance
    on source_instance.id = target_stack.source_card_id
  left join public.cards source_card
    on source_card.id = source_instance.card_id
  where target_stack.id = v_target_stack_item.id;

  return jsonb_build_object(
    'target_stack_item_id', v_target_stack_item.id,
    'target_stack_label', coalesce(v_target_stack_label, v_target_stack_item.action_type),
    'timing', p_timing
  );
end;
$$;

-- Keep builders off the PostgREST surface (reached only via the skeleton's
-- EXECUTE as the function owner).
revoke all on function public.build_stack_payload_deal_damage_player(uuid, uuid, jsonb, text, text) from public;
revoke all on function public.build_stack_payload_deal_damage_creature(uuid, uuid, jsonb, text, text) from public;
revoke all on function public.build_stack_payload_pump_creature(uuid, uuid, jsonb, text, text) from public;
revoke all on function public.build_stack_payload_creature_simple(uuid, uuid, jsonb, text, text) from public;
revoke all on function public.build_stack_payload_add_counters_creature(uuid, uuid, jsonb, text, text) from public;
revoke all on function public.build_stack_payload_grant_keyword_creature(uuid, uuid, jsonb, text, text) from public;
revoke all on function public.build_stack_payload_draw_cards(uuid, uuid, jsonb, text, text) from public;
revoke all on function public.build_stack_payload_counter_spell(uuid, uuid, jsonb, text, text) from public;

-- ---------------------------------------------------------------------------
-- Wire builders into the registry (idempotent; rows seeded by migration 104).
-- ---------------------------------------------------------------------------
update public.stack_action_handlers
set builder_fn = case action_type
  when 'deal_damage_player'    then 'build_stack_payload_deal_damage_player'
  when 'deal_damage_creature'  then 'build_stack_payload_deal_damage_creature'
  when 'pump_creature'         then 'build_stack_payload_pump_creature'
  when 'destroy_creature'      then 'build_stack_payload_creature_simple'
  when 'bounce_creature'       then 'build_stack_payload_creature_simple'
  when 'tap_creature'          then 'build_stack_payload_creature_simple'
  when 'untap_creature'        then 'build_stack_payload_creature_simple'
  when 'exile_creature'        then 'build_stack_payload_creature_simple'
  when 'add_counters_creature' then 'build_stack_payload_add_counters_creature'
  when 'grant_keyword_creature' then 'build_stack_payload_grant_keyword_creature'
  when 'draw_cards'            then 'build_stack_payload_draw_cards'
  when 'counter_spell'         then 'build_stack_payload_counter_spell'
end
where action_type in (
  'deal_damage_player', 'deal_damage_creature', 'pump_creature',
  'destroy_creature', 'bounce_creature', 'tap_creature', 'untap_creature',
  'exile_creature', 'add_counters_creature', 'grant_keyword_creature',
  'draw_cards', 'counter_spell'
);

-- ---------------------------------------------------------------------------
-- The skeleton. Auth/turn/priority/source/timing/sorcery/mana/insert/graveyard
-- are unchanged; the whitelist becomes a registry lookup and the validation +
-- payload chain becomes a single dynamic builder call.
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

  -- Data-driven whitelist: castable via put_action_on_stack iff the registry has
  -- a builder for this action type.
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
  v_target_controller := coalesce(lower(nullif(p_payload ->> 'target_controller', '')), 'any');

  -- Per-action validation + payload construction (data-driven). Raises on invalid
  -- input before any mana is paid, exactly as the old inline chain did. %I quotes
  -- the table-controlled, public-schema builder name.
  execute format('select public.%I($1, $2, $3, $4, $5)', v_builder_fn)
    into v_built_payload
    using p_session_id, auth.uid(), p_payload, v_action_timing, v_target_controller;

  if p_source_card_id is not null and v_source_zone = 'hand' then
    perform public.pay_mana_cost(p_session_id, auth.uid(), v_source_mana_cost, v_generic_payment);
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
